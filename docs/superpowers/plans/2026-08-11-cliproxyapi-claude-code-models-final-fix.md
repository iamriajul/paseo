# CLIProxyAPI Claude Code Models Final Fix Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Important findings 1–5 from the final branch review without attempting live CPA/platform certification or deferred minor findings.

**Architecture:** Keep diagnostic text collection separate from catalog refresh by reusing a ready global snapshot entry. Keep CPA discovery as a row-returning helper with a safe warning callback, so first-page failures reach the Claude client logger while partial pagination still returns collected rows. Treat auto-persist as a two-phase operation: discovered rows remain selectable, but capacity filled only by a failed persistence operation is removed and marked unresolved. Auto-persist records carry limits only; model-label precedence remains with configured/static metadata. The shared tooltip will open on press for native clients while retaining desktop hover behavior.

**Tech Stack:** TypeScript, Vitest, Pino logger, React Native/Expo, existing Tooltip and provider snapshot manager.

## Global Constraints

- Fix Important findings 1–5 only; Important 6 is deferred to PR QA sign-off and minors remain deferred.
- Never log Authorization values, tokens, headers, or raw request options.
- Do not restart the daemon on port 6767.
- Run only targeted Vitest files; never run a full suite locally.
- Run `npm run typecheck`, `npm run lint`, and `npm run format` after changes.
- Commit with clear messages and `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Append the completed evidence report to `.superpowers/sdd/2026-08-11-cliproxyapi-claude-code-models/final-fix-report.md`.

## File Map

- Modify `packages/server/src/server/agent/provider-snapshot-manager.ts` and its test to reuse ready diagnostics snapshots.
- Modify `packages/server/src/server/agent/providers/claude/cliproxy-models.ts` and its test for safe typed discovery warnings and capacity-only auto-persist records.
- Modify `packages/server/src/server/agent/providers/claude/agent.ts` and `agent.test.ts` for safe discovery warning logging and persistence-failure catalog handling.
- Modify `packages/server/src/server/agent/provider-registry.ts` and its test only if the actual merge seam needs an explicit fallback-label preservation rule.
- Modify `packages/app/src/components/ui/tooltip.tsx` and its focused test if needed to prove native press opens enabled tooltip content while web hover remains supported.
- Create the requested final-fix report; do not add live-certification claims.

### Task 1: Diagnostic snapshot reuse

**Files:** `provider-snapshot-manager.ts`, `provider-snapshot-manager.test.ts`

- [ ] Add a regression that warms a provider to `ready`, calls `getProviderDiagnostic`, and asserts the catalog fetch count remains one while diagnostic text is still fetched.
- [ ] Run the focused manager test and observe the new test fail because the current diagnostic path force-refreshes.
- [ ] In `refreshDiagnosticSnapshotEntry`, inspect the global snapshot before resetting it; return the ready entry unchanged. Leave the existing cold path force-refresh behavior intact.
- [ ] Rerun the focused manager test and verify both cold refresh and ready reuse behavior.

### Task 2: Discovery warnings and label-safe auto-persist

**Files:** `cliproxy-models.ts`, `cliproxy-models.test.ts`

- [ ] Add deterministic warning assertions for first-page request/HTTP/fingerprint/JSON failures and for a failed follow-up page, while asserting collected rows survive partial failure and warning payloads contain no token or headers.
- [ ] Run the focused CPA helper test and observe the new assertions fail against silent early returns.
- [ ] Add a typed warning code/callback to `fetchCliproxyAnthropicModels`; emit only safe status/page/phase data. First-page failures return no rows; follow-up failures return collected rows.
- [ ] Change capacity auto-persist records to contain `id` and resolved limits only. Add a regression showing a configured/static label stays unchanged when missing capacity is filled.
- [ ] Rerun the focused CPA helper test.

### Task 3: Catalog/persistence consistency

**Files:** `agent.ts`, `agent.test.ts`, and provider-registry files only if required by the label regression

- [ ] Add a `ClaudeAgentClient.fetchCatalog` regression with a real CPA-shaped response and a persistence callback that rejects; assert the discovered model remains selectable, auto-persist-derived limits are absent, and `needsCapacityConfig` is set.
- [ ] Add a first-page discovery-failure regression that captures the injected logger warning and proves the token/header data is absent.
- [ ] Run the focused Claude agent tests and observe the persistence and warning assertions fail before production changes.
- [ ] Pass the safe warning callback from `fetchCatalog` to the CPA helper and log structured warnings through the Claude logger without error objects or request metadata.
- [ ] Assign the enriched catalog only after auto-persist succeeds; on rejection, strip only limits supplied by the failed auto-persist records and mark those models unresolved/selectable.
- [ ] Rerun the focused Claude agent tests and any directly affected helper test.

### Task 4: Native non-compact warning touchability

**Files:** `packages/app/src/components/ui/tooltip.tsx`, focused tooltip test if practical

- [ ] Add a focused behavior assertion for an enabled tooltip trigger on native press, preserving the existing web interaction test.
- [ ] Run the focused tooltip test and observe the native press assertion fail against `openOnPress: isCompact`.
- [ ] Make the shared open-on-press condition platform-aware (`isCompact || isNative`) while leaving web hover/pointer behavior unchanged.
- [ ] Rerun the focused tooltip test under the package-local Vitest config.

### Task 5: Verification, report, and commits

- [ ] Run the exact targeted server/app Vitest files changed in this pass with `--bail=1`.
- [ ] Run `npm run format`, `npm run typecheck`, `npm run lint`, and `git diff --check`; inspect the final diff and status.
- [ ] Write the final-fix report with independent red/green evidence, deferred Important 6/minors, and no live-certification claim.
- [ ] Commit the scoped changes with the required trailer, then rerun status and final verification evidence from the committed tree.

## Self-review

- Important 1 maps to Task 1; Important 2 maps to Task 3; Important 3 maps to Tasks 2–3; Important 4 maps to Task 4; Important 5 maps to Tasks 2–3. Important 6 and minors are explicitly excluded.
- No task adds a network credential, a daemon restart, a broad test run, or a fallback that changes unrelated provider behavior.
- The post-persistence catalog rule keeps model discovery/selectability independent from successful config writes while preventing launch from observing capacity that was not persisted.
