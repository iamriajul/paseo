# CLIProxyAPI Claude Code model discovery — design

**Date:** 2026-08-11  
**Status:** Approved for implementation planning  
**Scope:** When Claude Code is routed through CLIProxyAPI, discover models via the Codex client catalog, append missing ones to the Claude picker, apply capacity correctly for native vs OpenAI-compat brands, and softly prompt for metadata when capacity is unresolved.

## Problem

Users run Claude Code through [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) by setting `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (process env or `~/.claude/settings.json`). CPA exposes many models (Claude, GPT subscription tiers, Grok, Gemini via Antigravity, plus OpenAI-compatible mounts such as OpenCode Go).

Paseo’s Claude catalog today is:

1. First-party hardcoded/manifest models
2. Sparse entries from `settings.json` model env pins (id only, no real limits)

It does **not**:

- Detect CPA
- List the full CPA model set
- Pull description / context window / reasoning metadata
- Distinguish trustworthy CPA capacity (subscription GPT, native Claude/Grok) from **templated** capacity on OpenAI-compat models (e.g. `qwen3.8-max` shown as 272k when OpenCode Go actually supports 1M)

Users must hand-add models like `grok-4.5` and set limits manually, even though CPA already knows the inventory.

## Goals

1. Detect when Claude Code is using CLIProxyAPI (fingerprint, not “any custom base URL”).
2. Discover models the **Codex way**: `GET /v1/models?client_version`.
3. Keep built-in Claude models; **append only** CPA models whose ids are not already present.
4. Use **raw** model ids (`grok-4.5`, `qwen3.8-max`) — never Anthropic-rewritten `claude-fable-5-dd-*` ids.
5. Trust CPA capacity only for **official CPA brands** (`owned_by` allowlist); otherwise resolve capacity via models.dev or user config.
6. Soft UX when metadata is incomplete: warning icon + tooltip, not a hard “Setup Required” gate.
7. Apply resolved limits at launch via existing Claude env pin paths (fill-if-missing).
8. Reuse existing provider models sheet **Refresh** / **Add Model** flows.

## Non-goals (v1)

- New top-level “CLIProxyAPI” provider
- Treating every non-empty `ANTHROPIC_BASE_URL` as CPA (Z.AI, OpenRouter, etc. stay unchanged)
- Anthropic-format `/v1/models` discovery or `claude-fable-5-dd-*` catalog ids
- Management API (`/v0/management/*`) — requires a different key; 401 with Claude’s API token
- Continuous background CPA polling independent of provider snapshot refresh
- Blocking model selection or agent create when capacity metadata is missing
- Changing how Claude Code itself talks to CPA at inference time

## Background: what CPA exposes

### Public proxy API (uses Claude’s API token)

| Endpoint                                             | Shape                                                                                                                                                           | Use                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `GET /v1/models?client_version`                      | Codex client catalog: `models[]` with `slug`, `display_name`, `description`, `context_window`, `max_context_window`, reasoning levels, modalities, `visibility` | **Primary discovery**                |
| `GET /v1/models` (no Anthropic headers)              | OpenAI list: `id`, `owned_by`, thin metadata                                                                                                                    | **`owned_by` trust bit**             |
| `GET /v1/models` + Anthropic-Version / claude-cli UA | Anthropic list; rewrites non-Claude ids to `claude-fable-5-dd-<reversed>`                                                                                       | **Do not use** for Paseo catalog ids |

Responses expose `X-CPA-*` headers (`X-CPA-VERSION`, `X-CPA-TRACE-ID`, …) for fingerprinting.

### How CPA builds Codex catalog capacity

From `CLIProxyAPI/sdk/api/handlers/openai/codex_client_models.go`:

1. If model id is in the official Codex template map → clone template (real subscription windows for GPT 5.6, etc.).
2. Else clone default template (`gpt-5.5`) and overlay `LookupModelInfo`:
   - Static/native definitions may set real `ContextLength` (Claude, Grok, Gemini, …).
   - OpenAI-compat config models **do not set** `ContextLength` → leftover default-template window (observed **272000**).

`owned_by` on the OpenAI list identifies the brand/compat name (e.g. `openai`, `anthropic`, `xai`, `antigravity`, `OpenCodeGo`).

## Product decisions (locked)

| Decision                         | Choice                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Approach                         | Claude-catalog overlay inside Claude `fetchCatalog`                                                    |
| Catalog merge                    | Keep built-in + settings models; **append only** missing CPA slugs                                     |
| Discovery protocol               | Codex `GET /v1/models?client_version`                                                                  |
| Model id                         | Raw `slug`                                                                                             |
| Detection                        | Resolved base URL + token + **`X-CPA-*` fingerprint**                                                  |
| Capacity trust                   | CPA only when `owned_by` ∈ official brands; else models.dev / user config                              |
| GPT subscription windows         | Trust CPA (do **not** overwrite with models.dev API windows)                                           |
| OpenAI-compat (e.g. OpenCode Go) | Never trust CPA capacity; models.dev or manual                                                         |
| Incomplete capacity UX           | Soft warning icon + tooltip; always selectable                                                         |
| Tooltip copy                     | **“Configure metadata for the best experience.”**                                                      |
| Warning control                  | Round hit target on **every** platform; **touchable** on every platform; **hover** only on web/desktop |
| Discovery trigger                | Existing Claude provider snapshot warm + **Refresh** in provider models sheet + post-config refresh    |
| Launch env                       | Catalog + fill-if-missing context/output (and related) pins                                            |
| Non-chat                         | Exclude image/video / `visibility: hide`                                                               |

## Architecture

```
Claude fetchCatalog / provider snapshot refresh
  ├─ base = manifest + settings.json models
  ├─ resolve ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
  │    (process/provider env, then ~/.claude/settings.json env)
  ├─ if missing → return base
  ├─ GET {base}/v1/models?client_version
  ├─ GET {base}/v1/models
  ├─ require X-CPA-* on at least one response → else return base
  ├─ join by slug/id; filter non-chat
  ├─ map Codex rows → AgentModelDefinition (raw slug)
  ├─ append only ids not in base
  ├─ capacity:
  │    profile/additionalModels limits win
  │    else if owned_by official → CPA context_window
  │    else models.dev on slug
  │       1 hit → auto-persist additionalModels limits
  │       N hits → needsCapacityConfig + candidates
  │       0/error → needsCapacityConfig (manual)
  └─ return catalog

Claude launch (existing pin path)
  └─ fill-if-missing CLAUDE_CODE_MAX_* from resolved catalog/profile limits
```

## Credential resolution

Order (first non-empty wins per key):

1. Effective Claude provider env (process + `agents.providers.claude.env` as already composed for the provider client)
2. `~/.claude/settings.json` → `env.ANTHROPIC_BASE_URL` / `env.ANTHROPIC_AUTH_TOKEN`
   - Config dir: `CLAUDE_CONFIG_DIR` or `~/.claude` (same as settings model discovery)

Trim whitespace. Both base URL and token required to attempt discovery.

Do **not** log raw tokens.

## Detection

1. Perform the two GETs with `Authorization: Bearer {token}`.
2. Treat as CPA only if any response includes a header whose name matches `/^x-cpa-/i`.
3. Non-CPA Anthropic-compatible gateways: no fingerprint → leave catalog unchanged (no false discovery).

Timeouts: short (same order as models.dev / metadata HTTP helpers; e.g. ~8s). Failures are non-fatal: log at debug/warn and keep the base catalog.

## Mapping Codex rows

| CPA field                               | Paseo field                                                  |
| --------------------------------------- | ------------------------------------------------------------ |
| `slug`                                  | `id`                                                         |
| `display_name`                          | `label` (fallback: slug)                                     |
| `description` if non-empty and ≠ slug   | `description`                                                |
| `context_window` when capacity trusted  | `contextWindowMaxTokens`                                     |
| reasoning levels / default when present | `thinkingOptions` / `defaultThinkingOptionId`                |
| OpenAI list `owned_by`                  | `metadata.ownedBy`                                           |
| —                                       | `metadata.source: "cliproxyapi"`                             |
| unresolved capacity                     | `needsCapacityConfig: true` + optional `modelsDevCandidates` |

Provider field remains `"claude"` — these are Claude Code launch targets, not a new provider.

### Non-chat filter

Exclude a row if any of:

- `visibility === "hide"`
- slug or display name matches image/video patterns (`image`, `video`, `gpt-image-`, `grok-imagine-`, …)
- supported modalities are only non-text (image/video) when that signal is present

## Official `owned_by` allowlist (capacity trust)

Normalize with trim + lowercase. Trust CPA capacity when `owned_by` is one of:

```
anthropic
openai
codex
xai
x-ai
grok
gemini
google
vertex
aistudio
antigravity
kimi
moonshot
```

Anything else (`OpenCodeGo`, custom compat names, empty, missing join) → **untrusted**.

If the OpenAI `/v1/models` call fails, treat all CPA-discovered rows as untrusted for capacity (safe default). Still append ids/labels from the Codex catalog when fingerprint succeeded.

## Capacity resolution

Precedence per model id:

1. **User/profile** `agents.providers.claude.additionalModels` (or `models`) entry with positive `contextWindowMaxTokens` / `maxOutputTokens` — always wins; clear `needsCapacityConfig`.
2. Else if **official `owned_by`** and CPA `context_window` > 0 → use CPA window; do **not** overwrite with models.dev.
3. Else → **models.dev** lookup on raw slug (`lookupModelsDevModel`):
   - **1 candidate** → auto-apply context + optional max output; **persist** into `additionalModels` (merge by id, preserve existing label if set); clear warning.
   - **N candidates** → set `needsCapacityConfig` + attach candidates for chooser; do not pick silently.
   - **0 / error** → set `needsCapacityConfig`; optional UI prefill from CPA window is display-only, never silent truth.

Auto-persist must go through the same daemon config store path as Add Model so it survives restarts and is editable.

## When discovery runs

No separate CPA scheduler. Discovery runs inside Claude `fetchCatalog`, which is invoked by the existing provider snapshot manager when:

| Trigger                                            | Notes                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| Snapshot warm                                      | Workspace open, model picker warm, agent create, etc.                           |
| **Refresh** in provider models sheet               | Gear → provider sheet → Refresh → `refresh([provider])` → forced `fetchCatalog` |
| After Add/Edit/Delete custom model                 | Existing sheet already refreshes the provider                                   |
| After auto-persist of models.dev single-hit limits | Patch config then refresh Claude snapshot                                       |

**Refresh** re-probes CPA. **Diagnostic** only re-fetches diagnostic text — out of scope. **Add Model** remains the manual path and the destination UI for multi-hit / zero-hit configuration.

## Incomplete metadata UX

Harsh “Setup Required” badge is rejected.

| Aspect                  | Behavior                                                                                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Indicator               | Soft **warning icon** on a **round hit target**                                                                                                                                                                               |
| Platforms               | Round target + **touch/press** on **every** platform; **hover** shows tooltip on web/desktop only (`isWeb` / hover patterns per app docs)                                                                                     |
| Tooltip / press message | **“Configure metadata for the best experience.”**                                                                                                                                                                             |
| Selectability           | Model remains fully selectable; no hard gate                                                                                                                                                                                  |
| Press behavior          | Show message (tooltip/popover). Explicit **Configure** (in popover or secondary control) opens: multi-candidate provider chooser, or capacity form when no candidates — reuse custom-model form / models.dev chooser patterns |
| After resolve           | Icon disappears on next catalog merge                                                                                                                                                                                         |

Wire signal (protocol-compatible; all optional):

```ts
// Preferred first-class optional fields on AgentModelDefinition
needsCapacityConfig?: boolean;
modelsDevCandidates?: Array<{
  providerId: string;
  matchedId: string;
  name?: string;
  contextWindowMaxTokens: number;
  maxOutputTokens?: number;
}>;
```

If first-class fields are deferred, pack under `metadata` with the same names — old clients ignore unknown keys.

## Launch env

When the selected Claude model has resolved positive limits (profile or trusted CPA or models.dev-persisted):

- Fill-if-missing `CLAUDE_CODE_MAX_CONTEXT_TOKENS` from `contextWindowMaxTokens`
- Fill-if-missing `CLAUDE_CODE_MAX_OUTPUT_TOKENS` from `maxOutputTokens` when known
- Auto-compact window from profile percent when context is known (existing helpers)
- Custom non-family env pins (`ANTHROPIC_DEFAULT_*`, `CLAUDE_CODE_SUBAGENT_MODEL`) remain as already designed

User/provider/process non-empty env always wins. Models with only a soft warning and no limits behave like today’s bare custom ids (selectable, no capacity env pins).

## Failure modes

| Case                 | Result                                            |
| -------------------- | ------------------------------------------------- |
| No base URL or token | Base catalog only                                 |
| No `X-CPA-*`         | Base catalog only                                 |
| Codex catalog fails  | Base catalog only                                 |
| OpenAI list fails    | Append from Codex catalog; all capacity untrusted |
| models.dev down      | Soft warning + manual configure                   |
| Timeout              | Non-blocking; do not hang Claude catalog forever  |
| Partial CPA list     | Append what was parsed; log parse issues          |

## Protocol / compatibility

- New model fields optional only (`needsCapacityConfig`, `modelsDevCandidates`).
- No required new RPCs for discovery (runs inside existing catalog/snapshot path).
- models.dev lookup RPC already exists.
- Config patch for `additionalModels` already exists.
- If a feature flag is needed for UI chrome only, gate on something like `server_info.features.claudeCliproxyModels` and tag with `// COMPAT(...)` per protocol-compatibility rules — prefer shipping without a flag if the server behavior is pure additive and failures no-op.

## Implementation sketch (files)

| Area                                      | Location                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| CPA resolve / fetch / map / trust / merge | `packages/server/src/server/agent/providers/claude/cliproxy-models.ts` (new) + tests |
| Hook into catalog                         | `packages/server/src/server/agent/providers/claude/agent.ts` `fetchCatalog`          |
| Capacity env at launch                    | Existing `models.ts` / `buildSdkEnv` helpers                                         |
| models.dev                                | `packages/server/src/server/models-dev/catalog.ts` (reuse)                           |
| Persist additionalModels                  | Daemon config store / existing provider config patch                                 |
| Protocol optional fields                  | `packages/protocol` agent model schema                                               |
| Warning icon + tooltip/press              | Provider models sheet + model picker rows (app)                                      |
| Docs                                      | `docs/custom-providers.md` short cross-link once shipped                             |

## Testing

Unit tests (preferred; no live CPA required):

1. Credential resolve: process vs settings.json precedence; missing keys skip.
2. Fingerprint: with/without `X-CPA-*`.
3. Merge: append only; never replace built-in id.
4. Trust matrix: `openai` / `anthropic` / `xai` / `antigravity` trusted; `OpenCodeGo` untrusted.
5. GPT subscription window not overwritten by models.dev when `owned_by === openai`.
6. models.dev: 1 → auto-persist shape; N → `needsCapacityConfig` + candidates; 0 → warning only.
7. Non-chat filter (image/video/hide).
8. Launch env fill-if-missing from trusted CPA / additionalModels.
9. OpenAI list failure → all untrusted capacity.

Optional integration: mock HTTP server returning Codex + OpenAI fixtures with CPA headers.

## Out-of-scope follow-ups

- Prefer models.dev provider via fuzzy match on `owned_by` when N > 1 (e.g. OpenCodeGo → `opencode-go`)
- Management-key static definitions for richer native metadata
- Background periodic CPA refresh
- Surfacing CPA fingerprint in Diagnostic text

## Summary

Detect CPA via credentials + `X-CPA-*`. Discover with Codex `?client_version` and join `owned_by` from plain `/v1/models`. Append raw slugs to the Claude catalog. Trust capacity only for official brands so subscription GPT windows stay correct and OpenCode Go Chinese models go through models.dev or soft configure UX. Reuse existing Refresh and Add Model; warn gently with a round, touchable control and the copy **“Configure metadata for the best experience.”**
