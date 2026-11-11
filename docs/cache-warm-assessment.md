# Prompt cache: assessment of the Claude Code features, and Hermes + Opus via the gateway

Working note, 11 November 2026, on `main` at `7d3e4b91a`. It may be folded into
[fork-decisions.md](fork-decisions.md#claude-prompt-cache-warming) and
[cliproxyapi.md](cliproxyapi.md) later; until then those two own the decisions, and this note
links to them rather than restating them.

## Summary

- **Claude Code: works, and pays for itself.** Over the 9 days of journals on this box
  (2 to 11 November, 207 sessions, about 81k requests), a turn that started after an idle gap read
  the cache 94.9% of the time. 1,094 of 1,289 warm-up stretches (85%) were followed by a
  hit. At API list prices, warm-ups cost about 117M input-token equivalents (38M of it on
  stretches that lapsed anyway) and avoided about 554M of rewrites: **4.7x return**. All 112
  tests in the four core suites pass. One real bug (warm-up wrongly blocked for Claude models
  the gateway does not serve) and one data-quality gap (non-Claude models counted as misses)
  are the top fixes.
- **Hermes + Opus via the gateway: possible to run, not ready to cache-manage.** Hermes can
  reach Opus through CLIProxyAPI, and the gateway places 1h cache breakpoints for it. None of
  Paseo's cache features work for an ACP provider today, because ACP gives Paseo only turn totals
  and context occupancy, never per-request cache read/write. See Part 2.

## Part 1: what exists for Claude Code

### Inventory

| Area                        | Where                                                                                                                                                                                                                                                                                                            | What it depends on from Claude Code                                                                                                                                                                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Per-request sample          | `providers/claude/agent.ts` `readStreamRequestCacheTokens`                                                                                                                                                                                                                                                       | SDK partial `stream_event` `message_start` with `usage.cache_read_input_tokens`, `cache_creation_input_tokens`, `input_tokens` and the `cache_creation.ephemeral_5m/1h_input_tokens` split (gives `writeTtl`). Main thread only.                                                                                                  |
| Recording                   | `agent-manager.ts` `recordPromptCacheRequest` → protocol `recordPromptCacheRequest`                                                                                                                                                                                                                              | Turn ids from the provider (`promptCacheTurnKey`), compaction timeline items. Hit = read ≥ 90% of the previous context.                                                                                                                                                                                                           |
| Journal                     | `agent/prompt-cache-journal.ts`, `$PASEO_HOME/prompt-cache/<agent>.jsonl`                                                                                                                                                                                                                                        | Nothing provider-specific; append-only, read whole on `agent.prompt_cache.history.request`.                                                                                                                                                                                                                                       |
| v1 ping warm-up             | `agent-cache-warm.ts` + Claude turn path                                                                                                                                                                                                                                                                         | A normal turn; `applyFlagSettings({ effortLevel })` to lower effort for the ping; `AskUserQuestion` / permission denial for close-pending.                                                                                                                                                                                        |
| v2 fork warm-up             | `ClaudeAgentSession.warmPromptCache`                                                                                                                                                                                                                                                                             | `resume` + `forkSession` + `persistSession: false` + `maxTurns: 1`; `ANTHROPIC_CUSTOM_HEADERS` to override `X-Claude-Code-Session-Id` so the gateway keeps the fork on the session's account; `CLAUDE_CODE_DISABLE_CLAUDE_MDS`; the fork's own `message_start` and `result.usage`.                                                |
| Idle-cap compaction         | `agent-cache-warm.ts` `compactsAtCap`                                                                                                                                                                                                                                                                            | `/compact` as a turn, the `compaction` timeline item.                                                                                                                                                                                                                                                                             |
| Compact on Haiku, then send | `agent/compact-with-model.ts`                                                                                                                                                                                                                                                                                    | Mid-session model switch + `/compact` + switch back.                                                                                                                                                                                                                                                                              |
| Close-pending               | `CACHE_WARM_QUESTION_PAUSE_MESSAGE`, `CACHE_WARM_PERMISSION_PAUSE_MESSAGE`                                                                                                                                                                                                                                       | Denying a pending `AskUserQuestion` / `canUseTool` so the turn ends.                                                                                                                                                                                                                                                              |
| Serving-account check       | `gateway/warm-up-account.ts`                                                                                                                                                                                                                                                                                     | CLIProxyAPI `/v1/session-route` (keyed `claude:<session id>` from `X-Claude-Code-Session-Id`) and `/v1/quota`.                                                                                                                                                                                                                    |
| Foreground shell cap        | `providers/claude/foreground-shell-cap.ts`                                                                                                                                                                                                                                                                       | PreToolUse hook on `Bash                                                                                                                                                                                                                                                                                                          | PowerShell`, `BASH_DEFAULT_TIMEOUT_MS` in flag settings. |
| Settings                    | `prompt_cache_ttl` (`Auto`/`5m`/`1h`) → `CLAUDE_CODE_PROMPT_CACHE_TTL` at process launch; `cache_warm`, `cache_warm_max_pings`, `cache_auto_compact` in `featureValues` (daemon-side only); host `daemon.cacheWarmMode`, `cacheAutoCompact`, `cacheExpiryStop`, `childReportExpiredCache`, `cacheWarmSubagents`. | The env variable; a window change needs a relaunch.                                                                                                                                                                                                                                                                               |
| App                         | `packages/app/src/prompt-cache/`                                                                                                                                                                                                                                                                                 | Pill + popover, sidebar flame/countdown/red miss count, Session insights dialog (explorer, active/idle split, cost split), money stats (off by default), warm-up stretches line, cold-send and model-switch guards, closed-permission banner, warm-up stop reasons. All gated to `provider === "claude" && isClaudeModel(model)`. |

### How well it works

**Evidence from tests.** `agent-cache-warm.test.ts` (51), `gateway/warm-up-account.test.ts`,
`prompt-cache-journal.test.ts` and `protocol/agent-cache-warm.test.ts` (61 together): all pass on
this commit once `npm run build:client` and the plugin package are built (a fresh worktree
fails to import `@getpaseo/plugin/internal/lifecycle` until then, which is a setup step, not a
defect).

**Evidence from use** (a one-off script, not committed, over `~/.paseo/prompt-cache/*.jsonl`, read only; same
hit rule as the daemon):

| Measure                          | Value                                                       |
| -------------------------------- | ----------------------------------------------------------- |
| Requests recorded                | 69,786 mid-turn, 5,831 turn starts, 5,518 warm-ups          |
| Turn-start hits                  | 5,192 of 5,469 measured (94.9%)                             |
| Turn-start misses by gap         | 84 over 1h (expected), 133 between 5m and 1h, 60 under 5m   |
| Warm-ups that read the cache     | 5,336 of 5,407 (98.7%)                                      |
| Warm-up stretches kept / lapsed  | 1,094 / 195; median 2 pings, p90 10 (the 5m cap)            |
| Warm-up cost vs. rewrite avoided | ≈117M vs ≈554M input-token equivalents at list prices: 4.7x |
| Idle-cap compactions             | 125 (48 other compactions)                                  |

Ratings:

| Part                          | Rating                                             | Notes                                                                                                                                                                                                                                                                                |
| ----------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Request tracking and hit/miss | Good                                               | One gap: non-Claude models (below).                                                                                                                                                                                                                                                  |
| v1 ping                       | Good                                               | Default. Costs transcript rows and needs an idle agent; close-pending covers the blocked case.                                                                                                                                                                                       |
| v2 fork                       | Promising, still experimental                      | Fixes the blocked-agent case and the transcript; depends on undocumented Claude Code behaviour (header override, CLAUDE.md re-read, task-notification empty `result`), each pinned by a test against a captured shape, not a live Claude Code. Re-check on each Claude Code upgrade. |
| Idle-cap compaction           | Good                                               | 125 runs; resumes on the next message.                                                                                                                                                                                                                                               |
| Serving-account check         | Correct for routed models, wrong for unrouted ones | Bug 1 below. New today; no live run yet.                                                                                                                                                                                                                                             |
| Insights / pill / money       | Good                                               | Rich; the dialog is the largest file (34k). Prices are list-price estimates, correctly labelled.                                                                                                                                                                                     |

### Gaps and bugs

1. **Bug: warm-up is blocked for a Claude model the gateway does not serve.**
   `readWarmUpAccountBlock` asks `providerSnapshotManager.isGatewayRouted(agent.provider)`, which
   is per provider (`provider-registry.ts:326`, true for `claude` whenever a gateway is set). But
   Claude routing is per model ([cliproxyapi.md](cliproxyapi.md#claude-launch-contract): "A
   manifest model it did not list launches with the local Claude Code login"). Such a session
   never reaches the gateway, so `/v1/session-route` answers its 404 envelope, the check returns
   `untracked`, and every warm-up for it is skipped. The docs say the opposite ("Only an agent the
   Gateway does not route warms unchecked"). The session-route watcher
   (`gateway/session-route-watcher.ts:131`) has the same per-provider test, which there only costs
   a wasted lookup. Fix: decide routing from the agent's model (the advertised-ids set the Claude
   catalog already keeps), and add the missing test case. Small (half a day).
2. **Data: requests from non-Claude models are recorded as misses.** Claude Code sessions that
   ran GPT or Gemini models through the gateway journalled 1,451 mid-turn "misses" with zero
   cache read (a translated upstream reports no Claude cache fields), 1,468 of the 1,499 mid-turn
   misses on this box. The app hides cache surfaces while the current model is not Claude, but
   the daemon's `promptCache.totals` and journal still count them, so a session that switches
   back to a Claude model shows an inflated red count and wrong insights. Fix: skip
   `recordPromptCacheRequest` (or mark the entry `uncacheable`) when `isClaudeModel(model)` is
   false. Small.
3. **133 turn-start misses between 5m and 1h, and 60 under 5m.** Some are expected (5m window
   with warm-up off or capped, account switches already labelled), but the journal cannot tell
   which without the stop reasons that only started today (`warm-up-stop` lines: none yet on
   this box). Re-run this analysis in a week; if unexplained misses under 5m remain, sample a few.
4. **The journal is read whole for every insights open.** 207 files, 18 MB, largest 780 KB here.
   Fine today; a month-long orchestrator will reach several MB. Paginate or summarize only if the
   dialog gets slow. Not urgent.
5. **Docs vs code.** Apart from bug 1, the docs match the code. `fork-decisions.md`'s
   `claude-prompt-cache-warming` section is about 25k characters in one entry and mixes rationale,
   history and UI copy; a reader cannot find the current rule for one sub-feature quickly. It is
   the doc to fold this note into, and to split by sub-feature when that happens.
6. **v2 depends on Claude Code internals.** The header override, the resumed process's CLAUDE.md
   tail and the empty task-notification `result` are each measured on one Claude Code version
   (2.1.314–2.1.318). Nothing re-checks them when Claude Code updates. A small local-stub probe
   in the release QA would catch a regression before warm-ups silently write cold.

### Prioritised improvements

1. Fix bug 1 (per-model routing in the account check) with a test. Half a day.
2. Exclude non-Claude-model requests from totals and the journal (gap 2). Half a day.
3. Add a v2 contract probe against a local stub to release QA (gap 6). One day.
4. Run v2 on a few long sessions now that the account check fails closed, then decide whether it
   becomes the default; it is the only method that keeps a blocked agent warm.
5. Re-run the journal analysis after a week of `warm-up-stop` lines (gap 3).

## Part 2: Hermes + Opus through CLIProxyAPI

Read from Hermes source at `3bcd0712` (11 November 2026, cloned read-only), CLIProxyAPI at
`be7a13d27` (`~/CLIProxyAPI`), and Paseo's ACP path. No requests were sent to any gateway or
model.

### 1. How Hermes calls Anthropic

- **Native Messages API** through the `anthropic` SDK when the provider has
  `api_mode: anthropic_messages` (`agent/anthropic_adapter.py:435-520`). Chat completions,
  Codex Responses and Bedrock are separate transports.
- **Four `cache_control` breakpoints**, one TTL for all (`agent/prompt_caching.py:345-377`): the
  stable system prefix, the end of the system prompt, and the last two non-system messages. A
  tools breakpoint is added only for `api.anthropic.com`; tools sit before the system prompt in
  the prefix, so the system breakpoint covers them.
- **TTL is configurable**: `prompt_caching.cache_ttl` = `5m` (default), `1h`, `auto` or off
  (`hermes_cli/config_defaults.py:684-688`). `auto` gives an ACP session 1h. Delegated children are
  clamped to 5m. No environment variable, no ACP config option; it is one value per Hermes home.
  Hermes sends no `extended-cache-ttl` beta header.
- **Caching turns on** for a third-party `anthropic_messages` endpoint only when the model id
  contains `claude` (`agent_runtime_helpers.py:1829`). On a plain custom `/v1/chat/completions`
  endpoint it is off unless the model entry sets `prompt_caching: true`.

### 2. The gateway

- Hermes points at CLIProxyAPI with a `providers.<name>` entry (`base_url`, `api_key`,
  `api_mode: anthropic_messages`) or `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`. Any non-
  `anthropic.com` host gets the key as `x-api-key`. No model allowlist; keep `claude` in the id.
- Paseo injects nothing: derived (`extends`) providers never inherit Gateway routing
  ([cliproxyapi.md](cliproxyapi.md)), so the Hermes config is the user's to write.
- **What CLIProxyAPI does with it.** Hermes is not Claude Code, so on an OAuth (subscription)
  account the gateway cloaks it (`internal/runtime/executor/claude_executor_execute.go:140-198`):
  it injects Claude Code's system blocks and `context_management`, takes over `cache_control`
  placement (`ensureCacheControlDoc`, capped at 4 breakpoints), and upgrades every breakpoint with
  no explicit `ttl` to **1h**, adding the `extended-cache-ttl` beta itself. A `ttl` Hermes writes
  out survives. So Hermes's default 5m becomes 1h on subscription accounts, and the caller cannot
  see that from its own config. On an API-key account the markers pass through as sent.
- **Session affinity.** CLIProxyAPI keys stickiness on headers
  (`sdk/cliproxy/session/info.go:83-96`). Hermes sends none by default; set
  `session_affinity_header: X-Session-ID` on its provider entry (opt-in,
  `hermes_cli/config_providers.py:516`) and the gateway tracks it as `header:<hermes session id>`.
  Without it the gateway falls back to a hash of the instructions and first user message
  (`ctx:v1:…`), which is stable per conversation but which Paseo cannot look up.

### 3. What usage reaches Paseo over ACP

| Field                                                                              | Hermes sends                                                                                                            | Paseo does                                                                                     |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `usage_update.size` / `used`                                                       | context window / a local token **estimate** (`acp_adapter/server.py:402-419`)                                           | context meter (`acp-agent.ts` `handleUsageUpdate`)                                             |
| `PromptResponse.usage.inputTokens`, `outputTokens`, `totalTokens`, `thoughtTokens` | **cumulative session totals**, reset when the agent is rebuilt (`server.py:1060-1068`, `agent/turn_finalizer.py:32-35`) | stored as the turn's usage (`mapACPUsage`), so Hermes turn figures in Paseo are running totals |
| `cachedReadTokens`                                                                 | cumulative                                                                                                              | `cachedInputTokens`                                                                            |
| `cachedWriteTokens`                                                                | **never sent**, though the ACP `Usage` type has it                                                                      | nothing                                                                                        |
| per request, `writeTtl`, cost                                                      | not sent                                                                                                                | nothing                                                                                        |

Hermes does record per-request cache read/write in its own `state.db` and log line
(`hermes_state_usage.py`, `agent/turn_usage.py:209-228`), but only as session counters and text.
The only per-request record with cache read/write that Paseo could read cleanly is the gateway's
own usage bus, which today is exposed only as `/v1/last-request-stats` per model, not per session.

### 4. Feature by feature

| Paseo feature                                             | For Hermes today | What it needs                                                                                                                                                                                                                                                                                                     | Size                                    |
| --------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Per-request tracking (read/write/uncached, gap, hit/miss) | Not possible     | Per-session, per-request usage from the gateway (a CLIProxyAPI route keyed by session, fed from its usage bus), read by the daemon after each turn like `session-route`. An ACP `_meta` extension in Hermes is the alternative but needs upstream.                                                                | CPA 2–3 days + Paseo 2–3 days           |
| Turn-level hit/miss only                                  | Partial          | Diff Hermes's cumulative `cachedReadTokens` per turn; ask upstream to also send `cachedWriteTokens` (a one-line Hermes change). Cannot see the first request of a turn on its own.                                                                                                                                | 1 day + upstream PR                     |
| Insights, pill, misses, money stats                       | Not possible     | Tracking above, then lift the `provider === "claude"` gates in the app and `resolveCacheWarmWindows`; pricing works for a `claude-*` id.                                                                                                                                                                          | 2 days after tracking                   |
| Account-aware check                                       | Needs X          | `session_affinity_header: X-Session-ID` in Hermes, a "routes through the gateway" flag on the ACP provider entry, and `header:<ACP session id>` in `gatewaySessionIdFor` (assumes Paseo's ACP session id is Hermes's session id; check). Then "Served by" works too.                                              | 1 day                                   |
| v1 ping warm-up                                           | Needs X          | An ACP warm-up path: send the ping as a prompt, recognise the reply. Leaves two transcript rows in Hermes's history (stored, replayed). No effort lowering. Timing needs a request anchor (tracking); without it the warm-up anchors on turn end, which the docs record as landing pings on a dead cache.         | 2 days after tracking                   |
| v2 fork warm-up                                           | Not possible     | `session/fork` exists but builds a new agent with a new session id (`acp_adapter/session.py:197`), so it gets a different affinity key and may rebuild the system prompt: a cold write, the failure v2 was redesigned to avoid. Would need a Hermes "fork that keeps the parent's request shape and affinity id". | Upstream, large                         |
| Cache window setting                                      | Needs X          | Only global (`prompt_caching.cache_ttl` in the Hermes home); on subscription accounts the gateway forces 1h on bare markers anyway. Per agent needs a per-agent Hermes home or an upstream config option. Paseo cannot observe the TTL without tracking.                                                          | Global: config only. Per agent: 2+ days |
| Compaction at the cap                                     | Needs X          | `/compress` is an ACP slash command; Paseo would send it as the idle-cap warm-up turn and recognise Hermes's compaction-summary `_meta`.                                                                                                                                                                          | 1 day after the ping path               |
| Compact on Haiku, then send                               | Config           | Pin `auxiliary.compression` to a cheaper model in Hermes; compression already runs as a one-shot side call.                                                                                                                                                                                                       | None in Paseo                           |
| Close-pending (question / permission)                     | Partial          | ACP permissions already go through Paseo; reuse the deny path.                                                                                                                                                                                                                                                    | Half a day, with the ping path          |
| Stop at expiry, cold-send guard                           | Not possible     | Needs a known expiry, so tracking first.                                                                                                                                                                                                                                                                          | 1 day after tracking                    |

### 5. Compared with Claude Code on the same gateway

- **Prefix stability: good.** Hermes builds its system prompt once per session (date only, no
  clock), saves the exact bytes of each per-turn injection and replays them, so history is
  byte-stable. What rewrites the prefix: compaction (`compression.threshold`, 0.50 of the window,
  at least 0.75 under 512K), `hermes sessions refresh-prompts`, MCP servers that connect late
  (appended to `tools`, which sit before the system prompt: one full miss), and opt-in
  `micro_compact` / `proactive_prune_tokens` (avoid both). Comparable to Claude Code.
- **Cache economics: similar per request, more side traffic.** Same Opus prices through the same
  gateway. Hermes's auxiliary tasks default to the main model, and `background_review` (on by
  default) replays the full conversation on it after turns: a cache read of the whole context at
  Opus prices each time. Pin auxiliary tasks to a cheaper model and consider turning
  `background_review` off. Delegated children run at 5m and cache separately.
- **No keep-warm of its own.** Nothing in Hermes keeps a cache alive; on a 1h window an idle user
  loses it after an hour, the same as Claude Code without Paseo's warm-up.
- **Gateway treatment.** Claude Code is a native client to CLIProxyAPI, so its requests and
  breakpoints pass through as Claude Code sent them. Hermes on subscription accounts is rewritten
  to look like Claude Code. That works, but every cache decision is then the gateway's, and the
  gateway, not Hermes or Paseo, is the only place that knows what was cached.
- **Quality.** Claude Code is the harness Opus is tuned against, and Paseo's richest provider
  (plan mode, subagents, hooks, the shell cap). Hermes brings persistent memory and skills, but
  through ACP Paseo sees less: no per-request data, no effort control, no fork.

## Recommendation

- **Run Hermes + Opus through the gateway today only for interactive or short sessions**, and
  configure it so caching works: `api_mode: anthropic_messages` against the gateway's
  `/v1/messages`, a model id containing `claude`, `prompt_caching.cache_ttl: "1h"`,
  `session_affinity_header: X-Session-ID`, auxiliary tasks pinned to a cheaper model,
  `micro_compact` off. Keep long-running owners and orchestrators on Claude Code: every Paseo cache
  feature that saved about 4.7x its cost on this box is blind for Hermes.
- **If Hermes is to carry long sessions, build first:** per-session request usage in CLIProxyAPI
  plus the daemon reader (tracking for every gateway harness, not only Hermes), then the account
  check mapping, then the ACP ping warm-up and `/compress` at the cap. About two weeks in all. Do
  not plan on v2 forks for Hermes.
- **Fix Part 1's bug 1 and gap 2 regardless.** They affect Claude Code users now.
