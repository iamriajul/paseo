---
name: fork-upstream-sync
description: Merge official Paseo into this fork without silently dropping fork decisions. Use when the user says "sync official", "merge upstream", "sync-official", or a scheduled sync agent runs.
---

# Fork upstream sync

You do not maintain a wiki of fork features. Decisions that edit official files live in `patches/fork/` (quilt/Electron series). Fork-owned files are normal git.

## Before you merge

1. Read `patches/fork/series` and every patch header (`Subject`, `Decision`, `Verify`).
2. Run `node scripts/fork-patches.mjs check` on current `main`. It must be green before you start. If it is not, the series is already stale — refresh it first, do not sync on top of a broken baseline.

## Merge

```bash
git fetch origin && git fetch upstream --tags
git checkout -B sync-official-vX.Y.Z origin/main
git merge vX.Y.Z
```

Resolve conflicts. Prefer composition (fork-owned module imported from a stable official hook) over reseating a large hunk. See `docs/fork-release.md`.

Fork-owned paths that official does not have: keep ours. Do not take "deleted by them" for `packages/app/src/heartbeats/`, `packages/server/src/server/browser-preview/`, and other files that exist only on the fork.

## After the merge

```bash
node scripts/fork-patches.mjs check
```

- **Green:** every decision still reverse-applies. Run each `Verify:` command in the series headers. Then typecheck/lint/format as usual.
- **FAIL:** official rewrote the site or the hunk was dropped. For each failed patch:
  1. Read `Decision:` — that is the policy, not the old line numbers.
  2. Try `node scripts/fork-patches.mjs apply` (`git apply --3way`). If it applies, refresh the patch from the new tree (keep the header, replace the diff).
  3. If `--3way` conflicts: re-implement the Decision in the new official shape. Then refresh the patch:
     ```bash
     git diff -U3 -- <Files from header> > /tmp/hunk.patch
     ```
     Splice that diff under the existing header in `patches/fork/<name>.patch`.
  4. Re-run `check` and the `Verify:` command. Do not merge the sync PR until both are green.

`git apply --reverse --check` failing while the Verify test still passes means the **hunk moved**. Refresh the patch to match the new site. Do not invert the Decision to make an old hunk apply.

## What you must not do

- Treat "the symbol still exists" as preserved. Fill-if-missing vs overwrite is a Decision; grep cannot see it.
- Merge a sync PR with red Playwright or a red `fork-patches` job.
- Add a markdown catalog of features. The series is the catalog.
- Edit `patches/*.patch` at repo root — those are patch-package for node_modules.

## New fork decision (edits an official file)

1. Implement + a contract test that states the policy in product language.
2. `git format-patch -1 HEAD --stdout`, prepend:

```
Subject: ...
Decision: one sentence policy
Verify: npx vitest run <file> --bail=1 -t "<test name>"
Files: <path>
```

3. Append the filename to `patches/fork/series`. Name it `<surface>-<feature>.patch`; qualify provider/surface when a bare noun is ambiguous (`claude-native-fork`, `codex-quota-reset`). Do not put the Decision in the filename.
4. `node scripts/fork-patches.mjs check` must pass.

If the change can live in a fork-owned file imported from one official hook, do that instead of a series entry.
