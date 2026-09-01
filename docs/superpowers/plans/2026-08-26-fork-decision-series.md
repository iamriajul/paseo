# Fork decision series Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the background sync agent a named, re-applicable stack of fork _decisions_ (Electron/quilt-style series + `--3way` + contract tests), not a wiki of features.

**Architecture:** Fork-owned files stay as normal git. Edits inside official files are one patch per decision under `patches/fork/`, listed in `patches/fork/series`. CI requires `git apply --reverse --check` so a dropped mount or inverted policy is red. A skill tells the sync agent how to apply, conflict, refresh, and run the bound test — not the list of features.

**Tech Stack:** git apply --3way, Node script, GitHub Actions, Claude skill

**Spec:** conversation design 2026-08-26 (composition first; series for class-2 hunks; contract tests encode policy)

## Global Constraints

- Do not add `docs/fork-decisions/` catalogs.
- `patches/` at repo root stays patch-package (node_modules). Fork decisions live in `patches/fork/`.
- One series entry ↔ one decision ↔ one `Verify:` command in the patch header.
- Merge-based sync stays: after `git merge` official, patches should already be in the tree; `check` confirms they still reverse-apply. If official rewrote the site, reverse-check fails and the agent reseats then refreshes the patch file.
- Seed only decisions that are true on current `main`. Do not add a series entry that makes CI red.

---

### Task 1: Series checker script + first decision patch

**Files:**

- Create: `scripts/fork-patches.mjs`
- Create: `scripts/fork-patches.test.mjs`
- Create: `patches/fork/series`
- Create: `patches/fork/claude-custom-context-window.patch`
- Modify: `package.json` (script `fork-patches`)
- Modify: `.github/workflows/ci.yml` (job `fork-patches`)
- Modify: `docs/fork-release.md` (Keeping Up With Upstream)
- Create: `.claude/skills/fork-upstream-sync/SKILL.md`
- Modify: `CLAUDE.md` (docs table + critical rule for sync agents)

- [ ] **Step 1:** Implement `scripts/fork-patches.mjs` with `check` (fail if any series patch does not `git apply -R --check`) and `apply` (for each patch: if reverse-check fails, `git apply --3way`). Parse DEP-3 `Verify:` from the patch header and print it. No network.

- [ ] **Step 2:** Export commit `8b5a44f04` as `patches/fork/claude-custom-context-window.patch` with DEP-3 headers (Subject, Decision, Verify, Files). `series` lists that filename only.

- [ ] **Step 3:** Test: `node scripts/fork-patches.mjs check` exits 0 on current tree; a mutated copy of the patch (hunk deleted from working tree simulation) is not required if unit-testing parse/series read is covered.

- [ ] **Step 4:** CI job on ubuntu-latest: checkout, `node scripts/fork-patches.mjs check`. No `npm ci`.

- [ ] **Step 5:** Skill + `docs/fork-release.md` rewrite of the sync section: load skill, run checker, on fail read the failing patch header and re-seat, refresh the patch, re-run checker and the Verify command. CLAUDE.md one row + one critical rule.
