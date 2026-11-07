// paseo/platform-split-exports: an import from shared code must resolve on every platform.
//
// Metro picks `foo.web.ts`, `foo.electron.ts`, `foo.ios.ts`, `foo.android.ts` or `foo.native.ts`
// over `foo.ts` per platform, but `tsc` only ever sees `foo.ts`. A name that only the base file
// exports therefore typechecks and then is `undefined` on the platforms that load a variant, which
// is how `useStatusRingRotation` crashed the web app. This rule resolves each local import the way
// every platform bundle would, reads what each resolved module exports, and reports a name that
// some platform's module does not export.

import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
let ts;
function typescript() {
  ts ??= require("typescript");
  return ts;
}

// Metro's per-platform lookup order: the platform's own extension first, then `.native` on
// iOS/Android, then the base file. Electron builds overlay `.electron` on top of web
// (packages/app/metro.config.cjs).
const TARGETS = {
  web: ["web", ""],
  electron: ["electron", "web", ""],
  ios: ["ios", "native", ""],
  android: ["android", "native", ""],
};
const TARGET_NAMES = Object.keys(TARGETS);
const PLATFORM_SUFFIXES = new Set(["web", "electron", "ios", "android", "native"]);
const SOURCE_EXTENSIONS = ["tsx", "ts", "jsx", "js"];
const SOURCE_FILE = /\.(tsx|ts|jsx|js)$/;

function normalize(file) {
  return file.replaceAll("\\", "/");
}

// `.../src/foo.web.tsx` → `.../src/foo`. The stem is what an import names.
function stemOf(file) {
  const withoutExtension = file.replace(SOURCE_FILE, "");
  const suffix = path.extname(withoutExtension).slice(1);
  return PLATFORM_SUFFIXES.has(suffix)
    ? withoutExtension.slice(0, -suffix.length - 1)
    : withoutExtension;
}

const fileExistsCache = new Map();
function isFile(candidate) {
  let exists = fileExistsCache.get(candidate);
  if (exists === undefined) {
    exists = existsSync(candidate) && statSync(candidate).isFile();
    fileExistsCache.set(candidate, exists);
  }
  return exists;
}

function resolveStem(stem, target) {
  for (const suffix of TARGETS[target]) {
    for (const extension of SOURCE_EXTENSIONS) {
      const candidate = suffix ? `${stem}.${suffix}.${extension}` : `${stem}.${extension}`;
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function resolveModule(specifier, importer, target) {
  let base;
  if (specifier.startsWith("@/")) {
    const marker = "/packages/app/src/";
    const index = importer.lastIndexOf(marker);
    if (index === -1) return null;
    base = importer.slice(0, index + marker.length) + specifier.slice(2);
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    base = normalize(path.resolve(path.dirname(importer), specifier));
  } else {
    return null;
  }
  // An explicit `./clock.web` names one file; `stemOf` would strip the suffix it asked for.
  if (isFile(base)) return base;
  return resolveStem(base, target) ?? resolveStem(`${base}/index`, target);
}

// Vitest resolves `.web` first (packages/app/vitest.config.ts), so tests only ever run web code.
const TEST_FILE = /\.(test|spec)\.(tsx|ts|jsx|js)$/;

// The platforms that bundle this file: the ones whose lookup for its stem lands on it.
function targetsOf(file) {
  if (TEST_FILE.test(file)) return ["web"];
  const stem = stemOf(file);
  return TARGET_NAMES.filter((target) => resolveStem(stem, target) === file);
}

// Most modules resolve to one file everywhere and re-export nothing, so their exports cannot
// differ by platform. A text scan finds those without paying for a parse.
const REEXPORT = /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})(?:\s*as\s+\w+)?\s*from\b/;
const reexportCache = new Map();
function hasReexports(file) {
  let found = reexportCache.get(file);
  if (found === undefined) {
    found = REEXPORT.test(readFileSync(file, "utf8"));
    reexportCache.set(file, found);
  }
  return found;
}

const parsedCache = new Map();
function parse(file) {
  let parsed = parsedCache.get(file);
  if (!parsed) {
    const t = typescript();
    const source = t.createSourceFile(file, readFileSync(file, "utf8"), t.ScriptTarget.Latest);
    parsed = { source, exports: null };
    parsedCache.set(file, parsed);
  }
  return parsed;
}

function hasExportModifier(node) {
  const t = typescript();
  return node.modifiers?.some((modifier) => modifier.kind === t.SyntaxKind.ExportKeyword) ?? false;
}

function hasDefaultModifier(node) {
  const t = typescript();
  return node.modifiers?.some((modifier) => modifier.kind === t.SyntaxKind.DefaultKeyword) ?? false;
}

function bindingNames(name, names = []) {
  const t = typescript();
  if (t.isIdentifier(name)) names.push(name.text);
  else
    for (const element of name.elements)
      if (!t.isOmittedExpression(element)) bindingNames(element.name, names);
  return names;
}

// Names this file declares at top level that only exist as types, so `export { Props }` can be
// told apart from `export { value }`.
function localTypeNames(source) {
  const t = typescript();
  const names = new Set();
  for (const statement of source.statements) {
    if (t.isInterfaceDeclaration(statement) || t.isTypeAliasDeclaration(statement)) {
      names.add(statement.name.text);
    } else if (t.isImportDeclaration(statement) && statement.importClause) {
      const clause = statement.importClause;
      for (const element of clause.namedBindings?.elements ?? []) {
        if (clause.isTypeOnly || element.isTypeOnly) names.add(element.name.text);
      }
    }
  }
  return names;
}

function moduleText(node) {
  return node.moduleSpecifier && typescript().isStringLiteral(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : null;
}

// Collects one module's exports: `names` maps each name to "value" | "type", and `files` is every
// file read to find them.
class ExportCollector {
  names = new Map();
  files = new Set();

  constructor(file) {
    this.files.add(file);
  }

  set(name, kind) {
    if (this.names.get(name) !== "value") this.names.set(name, kind);
  }

  // `export * from`, `export * as ns from`, `export { a } from` and `export { a }`.
  addExportDeclaration(statement, reexport, typeNames) {
    const t = typescript();
    for (const read of reexport?.files ?? []) this.files.add(read);
    const clause = statement.exportClause;
    if (!clause) {
      // `export * from` re-exports everything but the default. An unresolved package re-export is
      // opaque; this rule only reasons about files it can read.
      for (const [name, kind] of reexport?.names ?? [])
        if (name !== "default") this.set(name, kind);
      return;
    }
    if (t.isNamespaceExport(clause)) {
      this.set(clause.name.text, statement.isTypeOnly ? "type" : "value");
      return;
    }
    for (const element of clause.elements) {
      const local = (element.propertyName ?? element.name).text;
      this.set(element.name.text, exportedKind(statement, element, local, reexport, typeNames));
    }
  }

  // `export function`, `export const`, `export interface`, `export default`, `export =`.
  addDeclaration(statement) {
    const t = typescript();
    if (t.isExportAssignment(statement) || hasDefaultModifier(statement)) {
      this.set("default", "value");
    } else if (t.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) this.set(name, "value");
      }
    } else if (statement.name) {
      const isType = t.isInterfaceDeclaration(statement) || t.isTypeAliasDeclaration(statement);
      this.set(statement.name.text, isType ? "type" : "value");
    }
  }
}

function exportedKind(statement, element, local, reexport, typeNames) {
  if (statement.isTypeOnly || element.isTypeOnly) return "type";
  if (reexport) return reexport.names.get(local) ?? "value";
  return !statement.moduleSpecifier && typeNames.has(local) ? "type" : "value";
}

// What a module exports when bundled for `target`. Re-exports follow the same platform's
// resolution, so a shared barrel over a split module is split too.
const EMPTY_EXPORTS = { names: new Map(), files: new Set() };
function exportsOf(file, target, visiting = new Set()) {
  const key = `${file}\0${target}`;
  const parsed = parse(file);
  parsed.exports ??= new Map();
  const cached = parsed.exports.get(target);
  if (cached) return cached;
  if (visiting.has(key)) return EMPTY_EXPORTS;
  visiting.add(key);

  const t = typescript();
  const collector = new ExportCollector(file);
  const typeNames = localTypeNames(parsed.source);
  for (const statement of parsed.source.statements) {
    if (t.isExportDeclaration(statement)) {
      const specifier = moduleText(statement);
      const resolved = specifier ? resolveModule(specifier, file, target) : null;
      const reexport = resolved ? exportsOf(resolved, target, visiting) : null;
      collector.addExportDeclaration(statement, reexport, typeNames);
    } else if (t.isExportAssignment(statement) || hasExportModifier(statement)) {
      collector.addDeclaration(statement);
    }
  }

  visiting.delete(key);
  const result = { names: collector.names, files: collector.files };
  parsed.exports.set(target, result);
  return result;
}

function describe(file, cwd) {
  return normalize(path.relative(cwd, file));
}

export const platformSplitExports = {
  create(context) {
    const filename = normalize(context.filename);
    if (!SOURCE_FILE.test(filename) || filename.endsWith(".d.ts")) return {};
    const importerTargets = targetsOf(filename);
    if (importerTargets.length === 0) return {};
    const cwd = normalize(context.cwd ?? process.cwd());

    // Reports `name` when one platform this file ships on resolves `specifier` to a module that
    // exports it as a value and another resolves it to a module that does not export it at all.
    function check(node, specifier, name) {
      const resolved = importerTargets.map((target) => ({
        target,
        file: resolveModule(specifier, filename, target),
      }));
      if (resolved.some(({ file }) => !file)) return;
      if (
        resolved.every(({ file }) => file === resolved[0].file) &&
        !hasReexports(resolved[0].file)
      ) {
        return;
      }
      for (const entry of resolved) {
        const { names, files } = exportsOf(entry.file, entry.target);
        entry.kind = names.get(name);
        entry.files = files;
      }
      if (!resolved.some(({ kind }) => kind === "value")) return;
      const missing = resolved.filter(({ kind }) => kind === undefined);
      if (missing.length === 0) return;
      const exporting = resolved.find(({ kind }) => kind === "value");
      // Name the files where the platforms part ways, not a shared barrel both of them read.
      const differing = (entry, other) => {
        const own = [...entry.files].filter((file) => !other.files.has(file));
        return own.length > 0 ? own : [entry.file];
      };
      const exportingFiles = differing(exporting, missing[0]).map((file) => describe(file, cwd));
      const missingFiles = [
        ...new Set(missing.flatMap((entry) => differing(entry, exporting))),
      ].map((file) => describe(file, cwd));
      const missingTargets = missing.map(({ target }) => target).join(", ");
      context.report({
        node,
        message:
          `\`${name}\` from "${specifier}" is exported by ${exportingFiles.join(", ")} but not by ` +
          `${missingFiles.join(", ")}, which Metro loads on ${missingTargets}; there the import is ` +
          "undefined and crashes at runtime (tsc only checks the base file). Export it from every " +
          "platform variant, or move this code into a platform file (`.web.tsx`, `.native.tsx`) " +
          "that imports its own variant.",
      });
    }

    const namespaces = new Map();
    return {
      ImportDeclaration(node) {
        if (node.importKind === "type") return;
        const specifier = node.source.value;
        for (const element of node.specifiers) {
          if (element.type === "ImportSpecifier") {
            if (element.importKind === "type") continue;
            const imported = element.imported;
            check(
              element,
              specifier,
              imported.type === "Identifier" ? imported.name : imported.value,
            );
          } else if (element.type === "ImportDefaultSpecifier") {
            check(element, specifier, "default");
          } else if (element.type === "ImportNamespaceSpecifier") {
            namespaces.set(element.local.name, specifier);
          }
        }
      },
      ExportNamedDeclaration(node) {
        if (!node.source || node.exportKind === "type") return;
        for (const element of node.specifiers) {
          if (element.exportKind === "type") continue;
          const local = element.local;
          check(element, node.source.value, local.type === "Identifier" ? local.name : local.value);
        }
      },
      MemberExpression(node) {
        if (node.computed || node.object.type !== "Identifier") return;
        const specifier = namespaces.get(node.object.name);
        if (!specifier) return;
        let scope = context.sourceCode.getScope(node);
        while (scope && !scope.set.has(node.object.name)) scope = scope.upper;
        if (scope?.set.get(node.object.name)?.defs[0]?.type !== "ImportBinding") return;
        check(node.property, specifier, node.property.name);
      },
    };
  },
};
