import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseReleaseVersion } from "./release-version-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const rootPackagePath = path.join(rootDir, "package.json");

function usageAndExit(code = 1) {
  process.stderr.write("Usage: node scripts/stamp-package-version.mjs --version <semver>\n");
  process.exit(code);
}

function parseArgs(argv) {
  let version = "";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--version") {
      version = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usageAndExit(0);
    }
    usageAndExit();
  }

  if (!version) {
    usageAndExit();
  }

  return { version: parseReleaseVersion(version).version };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

const { version } = parseArgs(process.argv.slice(2));
const rootPackage = readJson(rootPackagePath);
const workspacePaths = Array.isArray(rootPackage.workspaces) ? rootPackage.workspaces : [];
const sharedMetadata = {
  homepage: rootPackage.homepage,
  repository: rootPackage.repository,
  author: rootPackage.author,
  license: rootPackage.license,
};
const dependencySections = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
const touched = [];

if (rootPackage.version !== version) {
  rootPackage.version = version;
  writeJson(rootPackagePath, rootPackage);
  touched.push("package.json");
}

for (const workspacePath of workspacePaths) {
  const packagePath = path.join(rootDir, workspacePath, "package.json");
  if (!existsSync(packagePath)) {
    continue;
  }

  const pkg = readJson(packagePath);
  let changed = false;

  if (pkg.version !== version) {
    pkg.version = version;
    changed = true;
  }

  if (pkg.name === "@getpaseo/desktop") {
    for (const [field, value] of Object.entries(sharedMetadata)) {
      if (JSON.stringify(pkg[field]) !== JSON.stringify(value)) {
        pkg[field] = value;
        changed = true;
      }
    }
  }

  const internalDepRange = pkg.private === true ? "*" : version;

  for (const section of dependencySections) {
    const deps = pkg[section];
    if (!deps || typeof deps !== "object") {
      continue;
    }

    for (const name of Object.keys(deps)) {
      if (!name.startsWith("@getpaseo/") || name === pkg.name) {
        continue;
      }
      if (deps[name] !== internalDepRange) {
        deps[name] = internalDepRange;
        changed = true;
      }
    }
  }

  if (changed) {
    writeJson(packagePath, pkg);
    touched.push(path.relative(rootDir, packagePath));
  }
}

if (touched.length === 0) {
  console.log(`Package versions already stamped to ${version}`);
} else {
  console.log(`Stamped package versions to ${version}:`);
  for (const file of touched) {
    console.log(`- ${file}`);
  }
}
