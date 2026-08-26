import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  parsePatchHeader,
  parseSeries,
  FORK_SERIES_PATH,
  FORK_PATCH_DIR,
} from "./fork-patches.mjs";
import { join } from "node:path";

test("parseSeries skips blanks and comments", () => {
  assert.deepEqual(parseSeries("# header\n\nclaude-custom-context-window.patch\n# skip\n\n"), [
    "claude-custom-context-window.patch",
  ]);
});

test("parsePatchHeader reads DEP-3 fields until the first diff", () => {
  const header = parsePatchHeader(`Subject: honor custom-model context window
Decision: profile window overwrites ambient CLAUDE_CODE_* env
Verify: npx vitest run packages/server/src/server/agent/providers/claude/models.test.ts --bail=1 -t "overwrites when the profile owns"
Files: packages/server/src/server/agent/providers/claude/models.ts
diff --git a/packages/server/src/server/agent/providers/claude/models.ts b/packages/server/src/server/agent/providers/claude/models.ts
--- a/x
+++ b/x
`);
  assert.equal(header.subject, "honor custom-model context window");
  assert.match(header.decision, /overwrites ambient/);
  assert.deepEqual(header.verify, [
    'npx vitest run packages/server/src/server/agent/providers/claude/models.test.ts --bail=1 -t "overwrites when the profile owns"',
  ]);
  assert.deepEqual(header.files, ["packages/server/src/server/agent/providers/claude/models.ts"]);
});

test("series files exist and reverse-apply on this tree", () => {
  assert.equal(existsSync(FORK_SERIES_PATH), true);
  const names = parseSeries(readFileSync(FORK_SERIES_PATH, "utf8"));
  assert.ok(names.length > 0, "series must list at least one decision");
  for (const name of names) {
    const path = join(FORK_PATCH_DIR, name);
    assert.equal(existsSync(path), true, `missing ${path}`);
    const result = spawnSync("git", ["apply", "-R", "--check", "--", path], { encoding: "utf8" });
    assert.equal(result.status, 0, `${name} does not reverse-apply:\n${result.stderr}`);
  }
});
