# CLIProxyAPI Claude Code model discovery — design

**Date:** 2026-08-11  
**Status:** Approved for implementation planning  
**Scope:** When Claude Code is routed through CLIProxyAPI, discover models via CPA’s Anthropic-format `/v1/models` list, decode rewritten ids to raw slugs, append missing ones to the Claude picker, apply capacity correctly for native vs OpenAI-compat brands, and softly prompt for metadata when capacity is unresolved.

## Problem

Users run Claude Code through [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) by setting `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (process env or `~/.claude/settings.json`). CPA exposes many models (Claude, GPT subscription tiers, Grok, Gemini via Antigravity, plus OpenAI-compatible mounts such as OpenCode Go).

Paseo’s Claude catalog today is:

1. First-party hardcoded/manifest models
2. Sparse entries from `settings.json` model env pins (id only, no real limits)

It does **not**:

- Detect CPA
- List the full CPA model set
- Pull description / context window / max output from the gateway
- Distinguish trustworthy CPA capacity (subscription GPT, native Claude/Grok) from **templated** capacity on OpenAI-compat models (e.g. `qwen3.8-max` under-advertised vs OpenCode Go’s real 1M)

Users must hand-add models like `grok-4.5` and set limits manually, even though CPA already lists them. Claude Code’s own TUI may still show 200k for gateway models that advertise 500k — Paseo should pin capacity from the list (and models.dev when needed) so runtime env matches reality.

## Goals

1. Detect when Claude Code is using CLIProxyAPI (fingerprint, not “any custom base URL”).
2. Discover models via **Anthropic-format** `GET /v1/models` (lightweight; includes input **and** output limits + `owned_by`).
3. Keep built-in Claude models; **append only** CPA models whose **decoded** ids are not already present.
4. Store and launch with **raw** model ids (`grok-4.5`, `qwen3.8-max`) — decode `claude-fable-5-dd-*` listing ids before catalog use.
5. Trust CPA capacity only for **official CPA brands** (`owned_by` allowlist); otherwise resolve capacity via models.dev or user config.
6. Soft UX when metadata is incomplete: warning icon + tooltip, not a hard “Setup Required” gate.
7. Apply resolved limits at launch via existing Claude env pin paths (fill-if-missing).
8. Reuse existing provider models sheet **Refresh** / **Add Model** flows.
9. Effort picker: use Claude custom-model / manifest defaults — **do not** import Codex reasoning ceilings (they under-cap Claude Code, e.g. Grok `max` works in CC but Codex lists only up to `high`).

## Non-goals (v1)

- New top-level “CLIProxyAPI” provider
- Treating every non-empty `ANTHROPIC_BASE_URL` as CPA (Z.AI, OpenRouter, etc. stay unchanged)
- Codex `GET /v1/models?client_version` for Claude discovery (heavy; no output limit; reasoning levels wrong for Claude Code)
- Copying Codex `supported_reasoning_levels` into Claude `thinkingOptions`
- Management API (`/v0/management/*`) — requires a different key; 401 with Claude’s API token
- Continuous background CPA polling independent of provider snapshot refresh
- Blocking model selection or agent create when capacity metadata is missing
- Changing how Claude Code itself talks to CPA at inference time

## Background: what CPA exposes

### Public proxy API (uses Claude’s API token)

| Endpoint                                             | Shape                                                                                       | Use for Claude CPA v1                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `GET /v1/models` + Anthropic-Version / claude-cli UA | Anthropic list: `id`, `display_name`, `owned_by`, `max_input_tokens`, `max_tokens`, …       | **Primary discovery** (limits + owned_by + id) |
| `GET /v1/models` (no Anthropic headers)              | OpenAI list: thin `id` / `owned_by`                                                         | Not required if Anthropic list is used         |
| `GET /v1/models?client_version`                      | Codex client catalog (huge: prompts, reasoning levels, `context_window`; **no** max output) | **Out of scope for Claude v1**                 |

CPA routes Anthropic-format models when `Anthropic-Version` is set **or** `User-Agent` starts with `claude-cli` (`isAnthropicModelsRequest`).

Responses expose `X-CPA-*` headers (`X-CPA-VERSION`, `X-CPA-TRACE-ID`, …) for fingerprinting.

### `claude-fable-5-dd-*` id rewrite

From `CLIProxyAPI/internal/util/claude_model.go`:

- **Encode** (Anthropic listing only): if id does **not** already start with `claude-`, list as `claude-fable-5-dd-` + reverse(characters of raw id).
- **Decode** (request routing / Paseo catalog): if id starts with `claude-fable-5-dd-`, strip prefix and reverse the remainder. Optional thinking suffix `model(high)` is preserved.
- Ids that already start with `claude-` are unchanged on the wire.

| Anthropic list `id`             | Decoded launch / catalog id |
| ------------------------------- | --------------------------- |
| `claude-fable-5-dd-5.4-korg`    | `grok-4.5`                  |
| `claude-fable-5-dd-los-6.5-tpg` | `gpt-5.6-sol`               |
| `claude-fable-5-dd-xam-8.3newq` | `qwen3.8-max`               |
| `claude-fable-5`                | `claude-fable-5`            |

Paseo **must** decode before append/select/launch. CPA also decodes on inbound inference, but Paseo should never show or persist the rewritten form as the user-facing model id.

### Why not Codex for Claude discovery

1. **No output limit** in the Codex catalog (`max_tokens` / max completion absent).
2. **Huge** responses (`base_instructions`, etc.).
3. **Reasoning levels are Codex-client metadata**, not Claude Code capability. Day-to-day: Grok in Codex tops out lower; in Claude Code **`max` works**. Importing Codex levels would incorrectly cap the Claude effort picker.
4. Anthropic list already has `owned_by`, `max_input_tokens`, and `max_tokens` in one lightweight call.

### Capacity trust still needed

OpenAI-compat mounts (e.g. `owned_by: OpenCodeGo`) often get **templated** limits on both formats. Official brands (`openai`, `anthropic`, `xai`, `antigravity`, …) get real registry/template windows (including subscription GPT context that models.dev would overstate as API-tier).

## Product decisions (locked)

| Decision                         | Choice                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Approach                         | Claude-catalog overlay inside Claude `fetchCatalog`                                                    |
| Catalog merge                    | Keep built-in + settings models; **append only** missing **decoded** ids                               |
| Discovery protocol               | Anthropic `GET /v1/models` (`Anthropic-Version` and/or `claude-cli` User-Agent)                        |
| Model id                         | Decode `claude-fable-5-dd-*` → raw id; never store rewritten ids                                       |
| Detection                        | Resolved base URL + token + **`X-CPA-*` fingerprint**                                                  |
| Capacity trust                   | CPA only when `owned_by` ∈ official brands; else models.dev / user config                              |
| Context field                    | `max_input_tokens` when trusted                                                                        |
| Output field                     | `max_tokens` when trusted (or models.dev / user when untrusted)                                        |
| GPT subscription windows         | Trust CPA (do **not** overwrite with models.dev API windows)                                           |
| OpenAI-compat (e.g. OpenCode Go) | Never trust CPA capacity; models.dev or manual                                                         |
| Effort / thinking                | Claude manifest or `getClaudeCustomModelThinkingOptions()` — **not** Codex reasoning levels            |
| Incomplete capacity UX           | Soft warning icon + tooltip; always selectable                                                         |
| Tooltip copy                     | **“Configure metadata for the best experience.”**                                                      |
| Warning control                  | Round hit target on **every** platform; **touchable** on every platform; **hover** only on web/desktop |
| Discovery trigger                | Existing Claude provider snapshot warm + **Refresh** in provider models sheet + post-config refresh    |
| Launch env                       | Catalog + fill-if-missing context/output (and related) pins                                            |
| Non-chat                         | Exclude image/video models by decoded id / display name patterns                                       |

## Architecture

```
Claude fetchCatalog / provider snapshot refresh
  ├─ base = manifest + settings.json models
  ├─ resolve ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
  │    (process/provider env, then ~/.claude/settings.json env)
  ├─ if missing → return base
  ├─ GET {base}/v1/models
  │    Authorization: Bearer {token}
  │    Anthropic-Version: 2023-06-01
  │    User-Agent: claude-cli/...  (optional; Version alone is enough)
  ├─ require X-CPA-* → else return base
  ├─ for each data[] row:
  │    decode id → rawId
  │    filter non-chat
  │    map display_name, owned_by, max_input_tokens, max_tokens
  ├─ append only rawIds not in base
  ├─ capacity:
  │    profile/additionalModels limits win
  │    else if owned_by official → CPA max_input_tokens / max_tokens
  │    else models.dev on rawId
  │       1 hit → auto-persist additionalModels limits
  │       N hits → needsCapacityConfig + candidates
  │       0/error → needsCapacityConfig
  ├─ thinkingOptions:
  │    built-in if rawId in manifest; else Claude custom-model defaults
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

1. `GET {base}/v1/models` with Bearer token + `Anthropic-Version: 2023-06-01` (and optionally `User-Agent: claude-cli/...`).
2. Treat as CPA only if the response includes a header whose name matches `/^x-cpa-/i`.
3. Non-CPA Anthropic-compatible gateways: no fingerprint → leave catalog unchanged.

Timeouts: short (same order as models.dev helpers; e.g. ~8s). Failures are non-fatal: log and keep the base catalog.

## Decode helper

Mirror CPA exactly:

```ts
const CLAUDE_DD_PREFIX = "claude-fable-5-dd-";

function decodeCliproxyClaudeModelId(id: string): string {
  // Preserve optional trailing thinking suffix: id(effort)
  const match = /^(.*)\(([^()]*)\)$/.exec(id);
  const base = match ? match[1]! : id;
  const suffix = match ? `(${match[2]})` : "";
  if (!base.startsWith(CLAUDE_DD_PREFIX)) return id;
  const encoded = base.slice(CLAUDE_DD_PREFIX.length);
  if (!encoded) return id;
  return [...encoded].reverse().join("") + suffix;
}
```

Unit-test against known pairs (`claude-fable-5-dd-5.4-korg` → `grok-4.5`, etc.).

## Mapping Anthropic rows

| CPA field           | Paseo field                                                                  |
| ------------------- | ---------------------------------------------------------------------------- |
| decoded `id`        | `id`                                                                         |
| `display_name`      | `label` (fallback: decoded id)                                               |
| `owned_by`          | `metadata.ownedBy`                                                           |
| `max_input_tokens`  | `contextWindowMaxTokens` **when capacity trusted**                           |
| `max_tokens`        | max output for launch/profile **when capacity trusted**                      |
| —                   | `metadata.source: "cliproxyapi"`                                             |
| unresolved capacity | `needsCapacityConfig: true` + optional `modelsDevCandidates`                 |
| thinking            | manifest match or `getClaudeCustomModelThinkingOptions()` — never from Codex |

Provider field remains `"claude"`.

### Non-chat filter

Exclude after decode if slug or display name matches image/video patterns (`image`, `video`, `gpt-image-`, `grok-imagine-`, …). Prefer decoded id for matching so rewritten forms still filter.

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

Anything else (`OpenCodeGo`, custom compat names, empty) → **untrusted**.

## Capacity resolution

Precedence per **decoded** model id:

1. **User/profile** `agents.providers.claude.additionalModels` (or `models`) with positive limits — always wins; clear `needsCapacityConfig`.
2. Else if **official `owned_by`** and positive CPA `max_input_tokens` / `max_tokens` → use those; do **not** overwrite with models.dev.
3. Else → **models.dev** lookup on decoded id:
   - **1 candidate** → auto-apply context + optional max output; **persist** into `additionalModels` (merge by id); clear warning.
   - **N candidates** → set `needsCapacityConfig` + attach candidates for chooser.
   - **0 / error** → set `needsCapacityConfig`; CPA numbers may prefill UI only, never silent truth.

Auto-persist uses the same daemon config path as Add Model.

## Effort / thinking

| Model class                        | Thinking source                                        |
| ---------------------------------- | ------------------------------------------------------ |
| Decoded id matches Claude manifest | Manifest effort set                                    |
| Appended CPA / custom non-family   | `getClaudeCustomModelThinkingOptions()` (includes max) |

Do **not** merge Codex `supported_reasoning_levels`. That list under-describes Claude Code (Grok: Codex ceiling `high`, Claude Code `max` works).

## When discovery runs

No separate CPA scheduler. Discovery runs inside Claude `fetchCatalog`, invoked by the provider snapshot manager when:

| Trigger                              | Notes                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------ |
| Snapshot warm                        | Workspace open, model picker warm, agent create, etc.                    |
| **Refresh** in provider models sheet | Gear → provider sheet → Refresh → `refresh([provider])` → forced catalog |
| After Add/Edit/Delete custom model   | Existing sheet already refreshes the provider                            |
| After auto-persist of models.dev hit | Patch config then refresh Claude snapshot                                |

**Refresh** re-probes CPA. **Diagnostic** only re-fetches diagnostic text. **Add Model** remains the manual path and the UI for multi-hit / zero-hit configuration.

## Incomplete metadata UX

| Aspect                  | Behavior                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| Indicator               | Soft **warning icon** on a **round hit target**                                                              |
| Platforms               | Round target + **touch/press** on **every** platform; **hover** shows tooltip on web/desktop only            |
| Tooltip / press message | **“Configure metadata for the best experience.”**                                                            |
| Selectability           | Fully selectable; no hard gate                                                                               |
| Press                   | Show message; explicit **Configure** opens models.dev chooser or capacity form (reuse custom-model patterns) |
| After resolve           | Icon disappears on next catalog merge                                                                        |

Wire signal (all optional, backward compatible):

```ts
needsCapacityConfig?: boolean;
modelsDevCandidates?: Array<{
  providerId: string;
  matchedId: string;
  name?: string;
  contextWindowMaxTokens: number;
  maxOutputTokens?: number;
}>;
```

If first-class fields are deferred, pack under `metadata` with the same names.

## Launch env

When the selected Claude model has resolved positive limits:

- Fill-if-missing `CLAUDE_CODE_MAX_CONTEXT_TOKENS` from `contextWindowMaxTokens`
- Fill-if-missing `CLAUDE_CODE_MAX_OUTPUT_TOKENS` from max output when known
- Auto-compact window from profile percent when context is known (existing helpers)
- Custom non-family env pins remain as already designed

User/provider/process non-empty env always wins. Soft-warning models with no limits behave like bare custom ids today.

## Failure modes

| Case                 | Result                                   |
| -------------------- | ---------------------------------------- |
| No base URL or token | Base catalog only                        |
| No `X-CPA-*`         | Base catalog only                        |
| Anthropic list fails | Base catalog only                        |
| models.dev down      | Soft warning + manual configure          |
| Timeout              | Non-blocking; do not hang Claude catalog |
| Partial parse        | Append what was parsed; log issues       |

## Protocol / compatibility

- New model fields optional only.
- No required new RPCs (runs inside existing catalog/snapshot path).
- models.dev lookup and `additionalModels` patch already exist.
- Prefer shipping without a feature flag if server behavior is pure additive and failures no-op; if UI needs a flag, use `server_info.features.*` + `// COMPAT(...)`.

## Implementation sketch (files)

| Area                                 | Location                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| Decode / fetch / map / trust / merge | `packages/server/src/server/agent/providers/claude/cliproxy-models.ts` + tests |
| Hook into catalog                    | `packages/server/src/server/agent/providers/claude/agent.ts` `fetchCatalog`    |
| Capacity env at launch               | Existing `models.ts` / `buildSdkEnv` helpers                                   |
| models.dev                           | `packages/server/src/server/models-dev/catalog.ts` (reuse)                     |
| Persist additionalModels             | Daemon config store / existing provider config patch                           |
| Protocol optional fields             | `packages/protocol` agent model schema                                         |
| Warning icon + tooltip/press         | Provider models sheet + model picker rows (app)                                |
| Docs                                 | `docs/custom-providers.md` short cross-link once shipped                       |

## Testing

1. Credential resolve: process vs settings.json; missing keys skip.
2. Fingerprint: with/without `X-CPA-*`.
3. Decode table: known `claude-fable-5-dd-*` pairs + unchanged `claude-*` ids + thinking suffix.
4. Merge: append only decoded ids; never replace built-in id; never store rewritten id.
5. Trust matrix: `openai` / `anthropic` / `xai` / `antigravity` trusted; `OpenCodeGo` untrusted.
6. Trusted rows map `max_input_tokens` → context and `max_tokens` → output.
7. GPT subscription window not overwritten by models.dev when official `owned_by`.
8. models.dev: 1 → auto-persist; N → `needsCapacityConfig` + candidates; 0 → warning only.
9. Thinking: appended models get custom-model defaults including `max` (not Codex-capped).
10. Non-chat filter on decoded ids.
11. Launch env fill-if-missing from trusted CPA / additionalModels.

Optional: mock HTTP Anthropic list with CPA headers.

## Out-of-scope follow-ups

- Prefer models.dev provider via fuzzy match on `owned_by` when N > 1
- Optional Codex join **only** for non-effort metadata (still do not import reasoning ceilings)
- Management-key static definitions
- Background periodic CPA refresh
- Surfacing CPA fingerprint in Diagnostic text

## Summary

Detect CPA via credentials + `X-CPA-*`. Discover with one Anthropic-format `/v1/models` call; decode `claude-fable-5-dd-*` to raw ids; take context from `max_input_tokens` and output from `max_tokens` when `owned_by` is official. OpenAI-compat brands use models.dev or soft configure UX. Effort stays on Claude defaults so Grok `max` remains available. Reuse existing Refresh and Add Model; warn gently with a round, touchable control and **“Configure metadata for the best experience.”**
