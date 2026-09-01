---
name: fork-upstream-sync
description: Rebase this fork onto a new official Paseo release without silently dropping fork decisions. Use when the user says "sync official", "merge upstream", "sync-official", or a scheduled sync agent runs.
user-invocable: true
---

# Fork upstream sync

Follow `docs/fork-sync.md` end-to-end.

This fork rebases onto upstream **stable release tags**. It never merges, and it never tracks `upstream/main`. A merge commit in `main` means the queue is broken.
