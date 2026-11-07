import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const oxlintBin = path.join(repoRoot, "node_modules/.bin/oxlint");
const pluginPath = path.join(repoRoot, "scripts/oxlint/paseo-plugin.mjs");

function lint(source, rule = "paseo/no-raw-pressable", options, filename = "probe.tsx") {
  const config = JSON.stringify({
    jsPlugins: [pluginPath],
    rules: { [rule]: options ? ["error", options] : "error" },
  });
  return lintWithConfig(source, config, filename);
}

function lintWithConfig(source, config, filename) {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-oxlint-"));
  try {
    writeFileSync(path.join(dir, ".oxlintrc.json"), config);
    mkdirSync(path.dirname(path.join(dir, filename)), { recursive: true });
    writeFileSync(path.join(dir, filename), source);
    const result = spawnSync(oxlintBin, ["-c", ".oxlintrc.json", filename], {
      cwd: dir,
      encoding: "utf8",
    });
    return { failed: result.status !== 0, output: result.stdout + result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a raw Pressable from react-native is reported", () => {
  const result = lint(
    'import { Pressable, View } from "react-native";\nexport { Pressable, View };\n',
  );
  assert.equal(result.failed, true);
  assert.match(result.output, /no-raw-pressable/);
});

test("an aliased gesture-handler touchable is reported", () => {
  const result = lint(
    'import { TouchableOpacity as Tap } from "react-native-gesture-handler";\nexport { Tap };\n',
  );
  assert.equal(result.failed, true);
  assert.match(result.output, /no-raw-pressable/);
});

test("press primitives and pressable types are allowed", () => {
  const result = lint(
    'import { View, type PressableProps } from "react-native";\n' +
      'import { ToolbarButton } from "@/components/ui/pane-content-toolbar";\n' +
      "export type Props = PressableProps;\nexport { View, ToolbarButton };\n",
  );
  assert.equal(result.failed, false, result.output);
});

for (const source of [
  'import { readFileSync as read } from "node:fs"; export { read };',
  'import { execSync } from "child_process"; export { execSync };',
  'import fs from "node:fs"; export const read = fs.readFileSync;',
  'import { default as fs } from "node:fs"; export const read = fs.readFileSync;',
  'import fs = require("node:fs"); export const read = fs.readFileSync;',
  'import * as fs from "fs"; export const read = fs["readFileSync"];',
  'import cp from "node:child_process"; export const run = cp.spawnSync;',
  'const { readFileSync: read } = require("node:fs"); export { read };',
  'const fs = require("fs"); export const read = fs.readFileSync;',
  'export const run = require("node:child_process").execFileSync;',
  'import fs from "node:fs"; const other = fs; export const read = other.statSync;',
  'export { readFileSync as read } from "node:fs";',
  'export const read = (await import("node:fs")).readFileSync;',
]) {
  test(`sync IO is reported: ${source}`, () => {
    const result = lint(source, "paseo/no-sync-io");
    assert.equal(result.failed, true, result.output);
    assert.match(result.output, /Synchronous Node IO/);
  });
}

test("async IO, types, unrelated methods and shadowed namespaces are allowed", () => {
  const result = lint(
    'import fs from "node:fs"; import { readFile } from "node:fs/promises";\n' +
      'import type { readFileSync } from "node:fs";\n' +
      "export const read = readFile; export const asyncRead = fs.promises.readFile;\n" +
      "export function unrelated(fs: { readFileSync(): void }) { fs.readFileSync(); }\n" +
      "export type Reader = typeof readFileSync;\n",
    "paseo/no-sync-io",
  );
  assert.equal(result.failed, false, result.output);
});

test("sync IO exceptions allow only named APIs in the named server module", () => {
  const options = { allow: { "server/startup.ts": ["readFileSync"] } };
  const source = 'import { readFileSync } from "node:fs"; export { readFileSync };';
  const allowed = lint(
    source,
    "paseo/no-sync-io",
    options,
    "packages/server/src/server/startup.ts",
  );
  assert.equal(allowed.failed, false, allowed.output);
  const otherFile = lint(
    source,
    "paseo/no-sync-io",
    options,
    "packages/server/src/server/session.ts",
  );
  assert.equal(otherFile.failed, true, otherFile.output);
  assert.match(otherFile.output, /Synchronous Node IO/);
  const otherApi = lint(
    'import fs from "node:fs"; export const read = fs.statSync;',
    "paseo/no-sync-io",
    options,
    "packages/server/src/server/startup.ts",
  );
  assert.equal(otherApi.failed, true, otherApi.output);
  assert.match(otherApi.output, /Synchronous Node IO/);
});

test("repository config guards request paths while allowing startup APIs and test fixtures", () => {
  const config = readFileSync(path.join(repoRoot, ".oxlintrc.json"), "utf8").replace(
    '"./scripts/oxlint/paseo-plugin.mjs"',
    JSON.stringify(pluginPath),
  );
  const source = 'import { existsSync } from "node:fs"; export const probe = existsSync;';
  const request = lintWithConfig(source, config, "packages/server/src/server/probe.ts");
  assert.equal(request.failed, true, request.output);
  assert.match(request.output, /Synchronous Node IO/);
  for (const filename of [
    "packages/server/src/server/config.ts",
    "packages/server/src/server/probe.test.ts",
    "packages/app/src/probe.ts",
  ]) {
    const result = lintWithConfig(source, config, filename);
    assert.equal(result.failed, false, result.output);
  }
});

test("sync IO exceptions must be removed when a module stops using the API", () => {
  const result = lint(
    'import { readFile } from "node:fs/promises"; export const read = readFile;',
    "paseo/no-sync-io",
    { allow: { "server/startup.ts": ["readFileSync"] } },
    "packages/server/src/server/startup.ts",
  );
  assert.equal(result.failed, true, result.output);
  assert.match(result.output, /Remove the unused sync IO exception for readFileSync/);
});

test("toSorted is reported, with the copy-then-sort fix in the message", () => {
  const result = lint(
    "export const sorted = [3, 1, 2].toSorted((a, b) => a - b);\n",
    "paseo/no-to-sorted",
    undefined,
    "probe.ts",
  );
  assert.equal(result.failed, true);
  assert.match(result.output, /no-to-sorted/);
  assert.match(result.output, /\[\.\.\.items\]\.sort/);
});

test("sorting a copy is allowed", () => {
  const result = lint(
    "export const sorted = [...[3, 1, 2]].sort((a, b) => a - b);\n",
    "paseo/no-to-sorted",
    undefined,
    "probe.ts",
  );
  assert.equal(result.failed, false, result.output);
});

// Lints `entry` inside a tree of files laid out like packages/app/src, so `@/` resolves.
function lintPlatformTree(files, entry) {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-oxlint-"));
  try {
    writeFileSync(
      path.join(dir, ".oxlintrc.json"),
      JSON.stringify({
        jsPlugins: [pluginPath],
        rules: { "paseo/platform-split-exports": "error" },
      }),
    );
    for (const [name, source] of Object.entries(files)) {
      const file = path.join(dir, "packages/app/src", name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, source);
    }
    const result = spawnSync(
      oxlintBin,
      ["-c", ".oxlintrc.json", path.join("packages/app/src", entry)],
      { cwd: dir, encoding: "utf8" },
    );
    return { failed: result.status !== 0, output: result.stdout + result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The production crash: the native clock exports a hook the web clock does not.
const SPLIT_CLOCK = {
  "ring/clock.ts":
    "export function useStatusRingRotation() { return 0; }\nexport const PERIOD = 900;\nexport interface Clock { now: number }\n",
  "ring/clock.web.ts":
    "export function useStatusRingAnimationRef() { return null; }\nexport const PERIOD = 900;\n",
};

test("shared code importing a name the web variant lacks is reported", () => {
  const result = lintPlatformTree(
    {
      ...SPLIT_CLOCK,
      "row.tsx":
        'import { useStatusRingRotation } from "@/ring/clock";\nexport const r = useStatusRingRotation;\n',
    },
    "row.tsx",
  );
  assert.equal(result.failed, true, result.output);
  assert.match(result.output, /platform-split-exports/);
  assert.match(result.output, /useStatusRingRotation/);
  assert.match(result.output, /clock\.web\.ts/);
  assert.match(result.output, /web, electron/);
});

test("names every variant exports, types, and a variant file's own imports are allowed", () => {
  const files = {
    ...SPLIT_CLOCK,
    "row.tsx":
      'import { PERIOD, type Clock } from "@/ring/clock";\nimport type { Clock as C } from "./ring/clock";\nexport const p: Clock | C | number = PERIOD;\n',
    "ring/index.web.tsx":
      'import { useStatusRingAnimationRef } from "@/ring/clock";\nexport const r = useStatusRingAnimationRef;\n',
    "ring/index.tsx":
      'import { useStatusRingRotation } from "@/ring/clock";\nexport const r = useStatusRingRotation;\n',
    "ring/explicit.tsx":
      'import { useStatusRingAnimationRef } from "@/ring/clock.web";\nexport const r = useStatusRingAnimationRef;\n',
  };
  for (const entry of ["row.tsx", "ring/index.web.tsx", "ring/index.tsx", "ring/explicit.tsx"]) {
    const result = lintPlatformTree(files, entry);
    assert.equal(result.failed, false, `${entry}: ${result.output}`);
  }
});

test("tests resolve the web variant only, as Vitest does", () => {
  const result = lintPlatformTree(
    {
      ...SPLIT_CLOCK,
      "ring/clock.test.ts":
        'import { useStatusRingAnimationRef } from "./clock";\nexport const r = useStatusRingAnimationRef;\n',
    },
    "ring/clock.test.ts",
  );
  assert.equal(result.failed, false, result.output);
});

test("a shared barrel over a split module, a namespace import, and an electron overlay are checked", () => {
  const barrel = lintPlatformTree(
    {
      "limit/impl.web.ts": "export const LIMIT = 1;\nexport function cap() {}\n",
      "limit/impl.native.ts": "export function cap() {}\n",
      "limit/index.ts": 'export * from "./impl";\n',
      "use.ts": 'import { LIMIT } from "@/limit";\nexport const l = LIMIT;\n',
    },
    "use.ts",
  );
  assert.equal(barrel.failed, true, barrel.output);
  assert.match(barrel.output, /LIMIT[\s\S]*impl\.native\.ts[\s\S]*ios, android/);

  const namespace = lintPlatformTree(
    {
      ...SPLIT_CLOCK,
      "row.tsx":
        'import * as clock from "@/ring/clock";\nexport const ok = clock.PERIOD;\nexport const r = clock.useStatusRingRotation;\n',
    },
    "row.tsx",
  );
  assert.equal(namespace.failed, true, namespace.output);
  assert.match(namespace.output, /`useStatusRingRotation`/);
  assert.doesNotMatch(namespace.output, /`PERIOD`/);

  const electron = lintPlatformTree(
    {
      "source.web.ts": "export function open() {}\nexport function close() {}\n",
      "source.electron.ts": "export function open() {}\n",
      "source.ts": "export function open() {}\nexport function close() {}\n",
      "use.ts": 'export { close } from "./source";\n',
    },
    "use.ts",
  );
  assert.equal(electron.failed, true, electron.output);
  assert.match(electron.output, /source\.electron\.ts, which Metro loads on electron;/);
});
