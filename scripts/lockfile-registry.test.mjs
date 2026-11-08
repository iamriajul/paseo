import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_REGISTRY = "https://registry.npmjs.org/";

// A machine whose npm registry is a private mirror writes the mirror's URL into every entry it adds.
// CI cannot reach it, and npm 10 dies with "Exit handler never called!" in every job instead of
// naming the host. This runs in the `changes` job, before any job installs.
export function foreignResolvedEntries(lockfile) {
  return Object.entries(lockfile.packages ?? {})
    .filter(([, entry]) => typeof entry.resolved === "string" && !entry.link)
    .filter(([, entry]) => !entry.resolved.startsWith(PUBLIC_REGISTRY))
    .map(([path, entry]) => `${path} -> ${entry.resolved}`);
}

test("every package in package-lock.json resolves from the public npm registry", () => {
  const lockfile = JSON.parse(readFileSync(resolve(repoRoot, "package-lock.json"), "utf8"));
  const foreign = foreignResolvedEntries(lockfile);
  assert.deepEqual(
    foreign,
    [],
    `Rewrite these to ${PUBLIC_REGISTRY} (the integrity hashes stay the same):\n${foreign.join("\n")}`,
  );
});

test("a mirror URL is reported and workspace links are not", () => {
  const foreign = foreignResolvedEntries({
    packages: {
      "": { name: "root" },
      "node_modules/@getpaseo/app": { resolved: "packages/app", link: true },
      "node_modules/ok": { resolved: "https://registry.npmjs.org/ok/-/ok-1.0.0.tgz" },
      "node_modules/bad": {
        resolved: "http://mirror.svc.cluster.local:8080/npm/bad/-/bad-1.0.0.tgz",
      },
    },
  });
  assert.deepEqual(foreign, [
    "node_modules/bad -> http://mirror.svc.cluster.local:8080/npm/bad/-/bad-1.0.0.tgz",
  ]);
});
