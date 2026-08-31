---
name: fork-upstream-sync
description: Rebase this fork onto a new official Paseo release without silently dropping fork decisions. Use when the user says "sync official", "merge upstream", "sync-official", or a scheduled sync agent runs.
---

# Fork upstream sync

This fork is a rebase queue. `main` is the upstream release tag we track plus one commit per fork change. No merge commits, no patch series — the commits are the fork.

We track upstream **stable releases**. `upstream/main` and prereleases (`*-beta.*`) are not sync targets.

## Before you rebase

1. Read `docs/fork-decisions.md`. One section per behaviour this fork changes inside an official file, each with the command that proves it.
2. Confirm a clean tree and take a backup:

```bash
git status --porcelain          # must be empty
git branch backup/pre-sync-$(git rev-parse --short HEAD) HEAD
```

3. Pick the target: the newest upstream tag that is not a prerelease.

## Rebase

```bash
git fetch upstream --tags
git rebase <vX.Y.Z>
```

Git replays the cards one at a time and stops on two things.

**A card conflicts.** Resolve only that card. `git log -1 --format=%s` names the feature; its section in `docs/fork-decisions.md` states the policy — that is what you preserve, not the old line numbers. Prefer composition (a fork-owned module imported from one official hook) over reseating a large hunk.

**A card goes empty** (`The previous cherry-pick is now empty`). Upstream implemented it themselves. Read their code to confirm it covers the decision, then:

```bash
git rebase --skip
```

and delete that section from `docs/fork-decisions.md`. The queue shrinking is the healthy outcome, not a failure.

Fork-owned paths official does not have — `packages/app/src/heartbeats/`, `packages/server/src/server/browser-preview/` — are never "deleted by them".

## After the rebase

```bash
npm run fork:verify
npm run typecheck && npm run lint
```

`fork:verify` runs every proof command in `docs/fork-decisions.md` and names each decision that no longer works. A failure is one of two things:

- **Upstream absorbed it** — drop the card, delete the section.
- **The rebase broke it** — fix the card.

Do not force-push until `fork:verify` is green.

## What you must not do

- Merge. This fork rebases onto release tags; it does not merge upstream.
- Treat "the symbol still exists" as preserved. Fill-if-missing versus overwrite is a decision, and grep cannot see it.
- Take `theirs` wholesale to make a conflict go away. That is how the fork lost find-in-chat and the PDF preview mounts in the v0.5.1 sync.
- Edit `patches/*.patch` at the repo root — those are patch-package for node_modules, unrelated to fork decisions.

## New fork change that edits an official file

1. Implement it, plus a test stating the policy in product language.
2. Commit it as one card, subject naming the feature.
3. Add a section to `docs/fork-decisions.md`: heading is the id, one sentence of policy, then a `bash` block with the command that fails without your change.

CI job `fork-decisions` fails if any documented decision has no proof command.

If the change fits in a fork-owned file imported from one official hook, do that instead. A change that touches no official file needs no section — it cannot conflict.
