# Syncing official Paseo

This fork is a rebase queue. `main` is an upstream release tag plus one commit per fork change, with no merge commits. Syncing replays those commits onto the next release tag.

We track **stable releases**. `upstream/main` moves ~16 commits a day and carries unfinished work; prereleases (`*-beta.*`) are not sync targets either.

Every behaviour the fork changes inside an official file has a section in [fork-decisions.md](fork-decisions.md) holding its policy and the command that proves it. The commits carry the code; that file carries the why.

## Pick the target

```bash
git fetch upstream --tags
git tag --list 'v*' --sort=-creatordate | grep -v -- '-beta' | head -5
```

Take the newest tag that is an ancestor of `upstream/main` and newer than your base. Upstream releases are linear — each contains the previous — so a plain `git rebase <tag>` is correct and you never need `--onto`.

## Rebase

```bash
git status --porcelain                                   # must be empty
git branch backup/pre-sync-$(git rev-parse --short HEAD)
git push origin backup/pre-sync-$(git rev-parse --short HEAD)
git rebase vX.Y.Z
```

Push the backup. A branch that exists only on your machine is not a backup.

`rerere` is enabled in this repo, so a conflict you resolve once is replayed automatically if you redo the rebase. Restarting a botched rebase is cheap; take it rather than forcing a bad resolution forward.

Git replays the commits one at a time and stops on two things.

**A commit conflicts.** Resolve that one commit. `git log -1 --format=%s` names the feature; its section in `fork-decisions.md` states the policy you are preserving — not the old line numbers. Then:

```bash
git add -A && git rebase --continue
```

Prefer composition (a fork-owned module imported from one official hook) over reseating a large hunk.

**A commit goes empty** — `The previous cherry-pick is now empty`. Upstream implemented it themselves. Read their code and confirm it actually covers the decision, then:

```bash
git rebase --skip
```

Write the id down. Delete its section from `fork-decisions.md` **after** the rebase finishes, as one commit — editing that file mid-rebase attaches the change to whichever commit is replaying. The queue shrinking is the healthy outcome.

Fork-owned paths official does not have — `packages/app/src/heartbeats/`, `packages/server/src/server/browser-preview/` — are never "deleted by them".

## Verify, then push

```bash
npm run fork:verify          # ~75s for the full set
npm run typecheck && npm run lint
git push --force-with-lease origin main
```

`fork:verify` runs every proof command in `fork-decisions.md` and names each decision that no longer works. A failure is one of two things:

- **Upstream absorbed it** — drop the commit and delete its section.
- **The rebase broke it** — fix the commit.

Use `--force-with-lease`, never bare `--force`. The lease refuses the push if the remote moved under you.

While iterating, run subsets: `npm run fork:verify -- <id> <id>`, or `-- --list` for the ids.

**Gotcha:** in a fresh worktree, `node_modules/electron` has no binary, so `browser-localhost-tunnel` fails with `Electron failed to install correctly`. That is the environment, not the decision. Run that one from the main checkout.

## The Nix hash always needs fixing

`nix/npm-deps.hash` pins a hash of the npm dependency closure. The fork changes
`package.json` and files under `packages/server/` and `packages/cli/`, all of which feed
that derivation, so the fork's hash is never the same as upstream's. A rebase brings
upstream's value across and it is always wrong:

```
error: hash mismatch in fixed-output derivation '/nix/store/…-npm-deps.drv'
```

Regenerate it locally and commit the result as its own card:

```bash
./scripts/update-nix.sh
```

Do not wait for the `Nix Update Hash` workflow to fix it. That workflow needs
`PASEO_BOT_APP_ID` and `PASEO_BOT_APP_PRIVATE_KEY` — upstream's GitHub App credentials,
which this fork does not have — so it fails on every run with
`Input required and not supplied: app-id`. Until those secrets exist, the hash is yours
to maintain, and `build-desktop-darwin` fails on every sync PR that skips this step.

## What not to do

- Merge. This fork rebases onto release tags. A merge commit in `main` means the queue is broken.
- Treat "the symbol still exists" as preserved. Fill-if-missing versus overwrite is a decision, and grep cannot see it.
- Take `theirs` wholesale to make a conflict go away. That is how the v0.5.1 sync lost three features — see [What past syncs lost](#what-past-syncs-lost).
- Edit `patches/*.patch` at the repo root — those are patch-package for `node_modules`, unrelated to fork decisions.

## What past syncs lost

One sync merge, `f1daed522` (PR #65, official v0.5.1), silently dropped three fork
features. They share a shape: the **call site** goes and the receiving code stays. Every
file still exists, typecheck stays green, `fork:verify` stays green, and nothing fails.
Only someone reaching for the feature finds out.

| Feature                                            | Wired by    | What went                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find in chat                                       | —           | the mount; restored, and now pinned by the `find-in-chat` decision                                                                                                                                                                                                                                    |
| PDF preview                                        | —           | the mount; restored, and now pinned by `pdf-file-preview`                                                                                                                                                                                                                                             |
| Localhost chat links open in the workspace Browser | `1caa0c87e` | `onOpenUrlInBrowserTab` in `packages/app/src/panels/agent-panel.tsx`: 16 occurrences in the merge's parent `c5fd95abc`, zero in the merge. `agent-stream/view.tsx` kept the receiving prop, so `view.tsx` still calls `onOpenUrlInBrowserTab?.(url)` on an argument nobody passes. **Still unwired.** |

To hunt for more, count a symbol's occurrences across a sync merge:

```bash
git log -S 'onOpenUrlInBrowserTab' --oneline f1daed522 -- packages/app/src/panels/agent-panel.tsx
```

Name the old commit explicitly. The fork rebases, so past sync merges are no longer
ancestors of `main` — the same command without `f1daed522` walks from `HEAD`, finds
nothing, and reads exactly like "nothing was lost".

Three casualties in one sync, all found afterwards and by accident, means the other syncs
were not audited either.

## Adding a change that edits an official file

1. Implement it, plus a test stating the policy in product language.
2. Commit it as one commit whose subject names the feature.
3. Add a section to [fork-decisions.md](fork-decisions.md): heading is the id, one sentence of policy, then a `bash` block with the command that fails without your change.

CI job `fork-decisions` fails if a documented decision has no proof command.

If the change fits in a fork-owned file imported from one official hook, do that instead. A change that touches no official file cannot conflict, so it needs no section.
