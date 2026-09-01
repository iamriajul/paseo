import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeReleaseTag, parseReleaseVersion } from "./release-version-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const rootPackagePath = path.join(rootDir, "package.json");
const dependencySections = ["dependencies", "optionalDependencies", "peerDependencies"];

function usageAndExit(code = 1) {
  process.stderr.write(
    "Usage: node scripts/link-release-package-assets.mjs --version <semver> --tag <tag> --repo <owner/repo>\n",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    version: "",
    tag: "",
    repo: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--version") {
      args.version = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--tag") {
      args.tag = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--repo") {
      args.repo = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usageAndExit(0);
    }
    usageAndExit();
  }

  if (!args.version || !args.tag || !args.repo) {
    usageAndExit();
  }

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repo)) {
    throw new Error(`Invalid GitHub repository "${args.repo}". Expected owner/repo.`);
  }

  return {
    version: parseReleaseVersion(args.version).version,
    tag: normalizeReleaseTag(args.tag),
    repo: args.repo,
  };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function getPackFileName(packageName, version) {
  const fileBase = packageName.startsWith("@")
    ? packageName.slice(1).replace("/", "-")
    : packageName;
  return `${fileBase}-${version}.tgz`;
}

function getReleaseAssetUrl(repo, tag, packageName, version) {
  return `https://github.com/${repo}/releases/download/${tag}/${getPackFileName(packageName, version)}`;
}

const { version, tag, repo } = parseArgs(process.argv.slice(2));
const rootPackage = readJson(rootPackagePath);
const workspacePaths = Array.isArray(rootPackage.workspaces) ? rootPackage.workspaces : [];
const publishedPackages = new Map();

for (const workspacePath of workspacePaths) {
  const packagePath = path.join(rootDir, workspacePath, "package.json");
  if (!existsSync(packagePath)) {
    continue;
  }

  const pkg = readJson(packagePath);
  if (pkg.private === true || pkg.publishConfig?.access !== "public") {
    continue;
  }
  if (typeof pkg.name === "string" && pkg.name.startsWith("@getpaseo/")) {
    publishedPackages.set(pkg.name, workspacePath);
  }
}

const touched = [];

for (const [packageName, workspacePath] of publishedPackages) {
  const packagePath = path.join(rootDir, workspacePath, "package.json");
  const pkg = readJson(packagePath);
  let changed = false;

  for (const section of dependencySections) {
    const deps = pkg[section];
    if (!deps || typeof deps !== "object") {
      continue;
    }

    for (const depName of Object.keys(deps)) {
      if (!publishedPackages.has(depName) || depName === packageName) {
        continue;
      }

      const releaseAssetUrl = getReleaseAssetUrl(repo, tag, depName, version);
      if (deps[depName] !== releaseAssetUrl) {
        deps[depName] = releaseAssetUrl;
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
  console.log("Release asset dependency URLs were already current.");
} else {
  console.log(`Linked internal package dependencies to ${repo}/${tag}:`);
  for (const file of touched) {
    console.log(`- ${file}`);
  }
}
