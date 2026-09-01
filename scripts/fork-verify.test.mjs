import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";
import { parseDecisions, DECISIONS_PATH } from "./fork-verify.mjs";

const F = "```";

test("parseDecisions pairs each heading with its bash block", () => {
  const decisions = parseDecisions(
    [
      "# Fork decisions",
      "prose that is not a decision",
      "## first-decision",
      "why it exists",
      `${F}bash`,
      "npx vitest run a.test.ts --bail=1",
      F,
      "## second-decision",
      `${F}bash`,
      "npx vitest run b.test.ts --bail=1",
      F,
    ].join("\n"),
  );
  assert.deepEqual(
    decisions.map((d) => d.id),
    ["first-decision", "second-decision"],
  );
  assert.deepEqual(decisions[0].commands, ["npx vitest run a.test.ts --bail=1"]);
  assert.deepEqual(decisions[1].commands, ["npx vitest run b.test.ts --bail=1"]);
});

test("parseDecisions keeps multi-command blocks", () => {
  const [decision] = parseDecisions(
    ["## multi", `${F}bash`, "npx vitest run a.test.ts", "npx vitest run b.test.ts", F].join("\n"),
  );
  assert.deepEqual(decision.commands, ["npx vitest run a.test.ts", "npx vitest run b.test.ts"]);
});

test("parseDecisions ignores headings inside a fence", () => {
  const decisions = parseDecisions(["## real", `${F}bash`, "## not-a-heading", F].join("\n"));
  assert.deepEqual(
    decisions.map((d) => d.id),
    ["real"],
  );
});

test("parseDecisions reports a decision with no proof command", () => {
  const [decision] = parseDecisions(["## unprotected", "prose only, no fence"].join("\n"));
  assert.deepEqual(decision.commands, []);
});

test("every decision in docs/fork-decisions.md carries a proof command", () => {
  assert.equal(existsSync(DECISIONS_PATH), true);
  const decisions = parseDecisions(readFileSync(DECISIONS_PATH, "utf8"));
  assert.ok(decisions.length > 0, "must document at least one decision");
  const unprotected = decisions.filter((d) => d.commands.length === 0).map((d) => d.id);
  assert.deepEqual(unprotected, [], `decisions with no proof command: ${unprotected.join(", ")}`);
});
