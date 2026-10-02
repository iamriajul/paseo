# CLIProxyAPI

Point Paseo at one [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) and every supported harness offers its advertised models. No per-provider `extends` entries, no harness config-file edits.

## Configure

Add one section to `config.json` (`$PASEO_HOME/config.json`):

```json
{
  "agents": {
    "cliproxyapi": {
      "enabled": true,
      "baseUrl": "http://cliproxyapi-host:8317",
      "apiKey": "sk-..."
    }
  }
}
```

`baseUrl` accepts the Claude form (`http://cliproxyapi-host:8317`) or the Codex/OpenCode form with a `/v1` suffix; Paseo normalizes it and appends `/v1` where a harness needs it. `PASEO_CLIPROXYAPI_BASE_URL` and `PASEO_CLIPROXYAPI_API_KEY` override the file when set, and either one enables CLIProxyAPI without the flag.

Restart the daemon after changing the routing. New models on an unchanged CLIProxyAPI need no restart: use the provider's `Refresh` button to re-run discovery.

## What each harness gets

| Harness  | Discovery                                                                      | Launch                                                                                        | Model IDs                                       |
| -------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Claude   | Anthropic `/v1/models`, decoded to raw IDs, appended to the manifest           | Gateway URL + token injected under explicit provider env                                      | Raw slugs (`grok-4.6`, `gpt-5.6-luna`)          |
| Codex    | Codex `?client_version` catalog, hidden rows skipped, appended to `model/list` | Synthetic `cliproxyapi` entry in thread `model_providers`                                     | Bare slugs; routing comes from `model_provider` |
| OpenCode | Same Anthropic rows as Claude, as `cliproxyapi/<slug>`                         | Injected `cliproxyapi` provider record (openai-compatible adapter, models map from live rows) | `cliproxyapi/<slug>`                            |
| OMP      | Live from the binary: `LITELLM_*` env exposes a `litellm` provider             | `LITELLM_BASE_URL` + `LITELLM_API_KEY` injected under explicit provider env                   | `litellm/<slug>`                                |

The Gateway applies only to the base `claude`, `codex`, `opencode`, and `omp` providers, and only when the provider has no routing of its own:

- Claude opts out when its override sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` (direct accounts, Z.AI, Qwen, work profiles).
- Codex opts out when its override sets `OPENAI_BASE_URL`.
- OpenCode always qualifies: the injected record is additive under a new provider ID and never reroutes existing providers. A user-defined `provider.cliproxyapi` wins entirely.
- OMP opts out when its override sets `LITELLM_BASE_URL` or `LITELLM_API_KEY`.
- Derived providers (`extends`) never inherit Gateway routing.

Discovery failures are non-fatal everywhere: the base catalog stays, and a warning names the phase. Detection runs only for auto-discovered custom endpoints: an `X-CPA-*` response header proves the Gateway, and when headers are absent (observed on current Gateways) the `claude-fable-5-dd-` id rewrite or the Codex `models` envelope proves it behaviorally instead. Anything else is left alone with a `missing_fingerprint` warning, so non-Gateway endpoints keep working. First-party routing skips detection — configuring the Gateway is the proof. A derived Codex provider that points at a Gateway gets Codex discovery too, through the same gates.

## Claude launch contract

Gateway models launch with raw decoded IDs through the standard Claude path, plus:

- Context/output/auto-compact env use the window CPA advertises for discovered ids that are not in the Claude manifest. First-party ids stay on the manifest: the 200k row, its separate `[1m]` variant, and Opus 5.5 at 1M. models.dev fills only fields the CPA row omitted. A row with no window and an ambiguous models.dev hit keeps the soft "configure metadata" warning; the warning opens that model's metadata form.
- Claude injection is per model. A session gets `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` only when CLIProxyAPI advertised that model. `[1m]` is a harness context flag on the same id, so an advertised `claude-opus-4-8` also routes `claude-opus-4-8[1m]`. A manifest model it did not list launches with the local Claude Code login. A hand-added custom model it did not list does the same.
- Codex routes a slug through CLIProxyAPI when the gateway advertised it, including a first-party slug Codex also lists. A slug the gateway did not advertise keeps the local login, and that process does not receive the gateway `OPENAI_*` env. OpenCode and OMP were already per model: CLIProxyAPI rows are `cliproxyapi/<slug>` and `litellm/<slug>`.
- Codex models use the context window advertised by CLIProxyAPI. Discovered models and base models overlay the advertised window in the catalog, write a merged `codex-model-catalog.json` for `codex app-server` (preventing fallback model clamping to 272k / 258k usable), supply `model_context_window` in thread config, and preserve the full context window in usage tracking.
- Custom non-family models pin the five family/subagent vars (`ANTHROPIC_DEFAULT_*_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`) to the selected model. User-set values win; first-party models are untouched.
- Image attachments check known `inputModalities`: a model known to be text-only gets a local-file path hint instead of image blocks. Unknown modalities keep forwarding images.
- Mid-session switches the SDK control plane rejects (`Couldn't confirm model ...`) relaunch the query on the resumed session with the new model.
- Per-model effort levels come from the Codex-shape catalog (`?client_version`), not from the Anthropic `/v1/models` shape, which carries no effort data. A model the catalog lists gets exactly the levels it advertises; a model it does not list keeps the full custom set. Ultra Code rides on `xhigh`, so it goes when `xhigh` does.
- Claude is told the gateway model's real name and capabilities through `ANTHROPIC_CUSTOM_MODEL_OPTION_*` and `ANTHROPIC_DEFAULT_FABLE_MODEL_*`. Without them Claude Code does not recognize the id, assumes every effort level is supported, and attributes commits to Fable. The capability list carries the same `max_effort` / `xhigh_effort` tokens Claude Code's own model catalog uses.

## Boot and gateway outages

The daemon resolves provider catalogs before it resumes anything that was running when it went down, so a power-loss resume launches against a warm catalog rather than an empty one. Without that ordering a gateway model falls back to Claude Code's assumed 200K window and the resumed transcript is compacted against that wrong ceiling.

Catalog responses are cached under `$PASEO_HOME/cache/cliproxyapi/`, one file per request URL. Discovery prefers a live catalog; it falls back to the cache only when the gateway answered with no models, and logs that it did. With neither a live nor a cached catalog, the daemon logs that gateway models will assume 200K, because that is the failure a user would otherwise only discover as a silent compaction.

Set `PASEO_DISABLE_GATEWAY_CACHE=1` to skip the cache entirely. Both vitest configs set it, so suites never write a gateway cache into a real `$PASEO_HOME`.

## Out of scope

- `[1m]` variant synthesis, Fast mode for non-manifest models, and `supportedModels()` control-plane reads.

## Quota

The composer meter tooltip shows per-model CLIProxyAPI quota for the agent's selected model through the `cliproxyapi.quota.get` RPC (gated on `server_info.features.cliproxyapiQuota`). The daemon maps the Paseo model id to the CLIProxyAPI slug — raw for Claude (wire form decoded, `[1m]`/thinking suffixes stripped), bare for Codex, `cliproxyapi/` and `litellm/` prefixes stripped for OpenCode and OMP — and only queries when that provider is CLIProxyAPI-routed. Results cache for 60 seconds.

CLIProxyAPI builds that predate `/v1/quota` answer 404 with an empty body (observed live); current builds answer errors with a JSON envelope. Anything but a valid quota payload — missing route, unknown model, bad key, unparseable body, transport failure — returns `supported: false` and the tooltip hides the section instead of showing an error.

## Latest request

The context-meter tooltip shows a "CLIProxyAPI latest request" section beside the quota section, reading `cliproxyapi.stats.get` (gated on `server_info.features.cliproxyapiStats`). It maps the model id with the same slug resolver quota uses and hits `/v1/last-request-stats`, which reports token and timing stats for the last request that model served.

The section is a label/value table: first token, generating, then — below a rule — the derived total, throughput, and how long ago the request ran. The rule separates what the Gateway measured from what Paseo computes from it, which is how the reader sees that throughput is computed over generation time alone and not the total.

It is read only while the tooltip is open, polled every 3s (`GATEWAY_STATS_POLL_MS`). Opening the tooltip starts the poll and closing it stops the interval with it, so a closed tooltip costs nothing. The poll exists because a throughput figure someone is watching should visibly move; the section is still scoped to the _last_ request rather than an aggregate, so the numbers re-render to the same model on every tick and a model that stops being served stops producing new rows.

Everything that is not a usable 200 record — a model that has not run, a provider that is not CLIProxyAPI-routed, a Gateway build without the route — hides the section. There is no in-body empty state to distinguish those cases, so they render identically.

The route was `/v1/last-request-tps` through CLIProxyAPI v8.0.901 and became `/v1/last-request-stats` in v8.0.902 — it reports more than throughput. The body is unchanged and the old path is not served, so a Gateway older than v8.0.902 answers 404 for both names. Assume the route is absent until you have probed the Gateway you run: the Gateway reachable while this shipped answered 401 on `/v1/quota` and an empty 404 here.

## Terminal tabs

The table above covers Paseo-managed agents. A terminal tab runs the harness as an ordinary child process, so the agent path injects nothing there. With a Gateway configured, Paseo writes three shims into a shim directory under `$PASEO_HOME` — `harness-shims`, or `cmd-shims` on Windows where the wrappers are `.cmd` — and puts that directory on terminal PATH:

| Harness  | Shim applies                                                                                 | Opt-out                                                |
| -------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Claude   | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` | terminal `ANTHROPIC_*`, or a settings.json `env` block |
| Codex    | `OPENAI_*` plus a `model_providers.cliproxyapi` map, which Codex only accepts from argv      | terminal `OPENAI_BASE_URL` or `OPENAI_API_KEY`         |
| OpenCode | `OPENCODE_CONFIG_CONTENT` with a `provider` map carrying the `cliproxyapi` record            | terminal `OPENCODE_CONFIG_CONTENT`                     |
| OMP      | none — `LITELLM_BASE_URL` / `LITELLM_API_KEY` go straight into the terminal env              | terminal `LITELLM_*` env                               |

The opt-out is all-or-nothing per harness: a shim either injects its whole env and argv or none of it. Partially applying one would strand a terminal's own credentials against the gateway's endpoint — a codex terminal exporting its own `OPENAI_API_KEY` would keep that key while its endpoint was rerouted. A terminal that already routes a harness keeps doing so, which is the terminal-side spelling of the agent path's rules above.

Shims rather than plain env, for two reasons. Codex only reads `model_providers` from argv, so env cannot route it at all; and injected env would put three gateway credentials in front of every unrelated process in the shell. The shim removes its own directory from PATH before exec'ing the real binary, so only the harness invocation sees the injection — and because that strip uses `$0`, a shim reached by bare name (`claude`, as typed in a terminal) resolves past itself correctly.

`PASEO_CLIPROXYAPI_DISABLE_SHIM=1` runs one invocation against the real binary with nothing injected:

```bash
PASEO_CLIPROXYAPI_DISABLE_SHIM=1 claude
```

Shims are rewritten on every terminal create, so editing `agents.cliproxyapi` reaches new terminals without a daemon restart. Already-open terminals keep the gateway they started with.

**Claude's settings.json wins.** An `env` block in `~/.claude/settings.json` overrides the shim, because the harness applies it after inheriting process env. The shim is a default, not an override: it helps when no file conflicts, and does nothing when one does. If you set `ANTHROPIC_BASE_URL` there, terminal Claude keeps using it — which is usually what you want, and is the same reason the file-based route is left alone.

`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` is an undocumented internal flag (verified against the binary, not a published contract). It makes Claude read `/v1/models` at `[Bootstrap]` so the TUI model picker lists Gateway slugs. If a future Claude release drops it, terminal model discovery regresses and the shim's env becomes inert; the rest of the routing still works.

**A Claude terminal gets the endpoint and the key, and nothing else.** No context window, no output limit, no per-model capability metadata — the shim cannot supply them, because Claude only asks `/v1/models` for a model's id and description and treats anything it does not recognise as a 200k model. The agent path can set the window because it knows the model before launch; a TUI session picks the model afterwards, and Claude reads no per-model window from a Gateway. So a Gateway model with a 1M window still runs at 200k in a terminal, and `CLAUDE_CODE_MAX_CONTEXT_TOKENS` does not change that on its own — Claude reads it only under `DISABLE_COMPACT`. Expect this to stay until Claude grows a surface for it.

OpenCode's shim sets `OPENCODE_CONFIG_CONTENT` to a config document whose `provider` map carries the `cliproxyapi` record. The wrapper is load-bearing: OpenCode deep-merges its config sources in order, keyed on the schema's top-level names, so a bare `{cliproxyapi: …}` has no `provider` key to merge into and the provider never registers. A document that does carry `provider` joins the user's existing map instead of replacing it, which is why the shim can route OpenCode without touching the user's config files.

That merge runs after the user's config files, so a `provider.cliproxyapi` written in `opencode.json` loses to the shim's record — the reverse of the agent path, where the user's record wins. Exporting `OPENCODE_CONFIG_CONTENT` in the terminal is the way to keep yours.

The shim registers the provider with an empty `models` map. The agent path populates the live catalog; a terminal session gets the provider but picks its model from OpenCode's own picker.

Resolving routing writes the shims to disk, so it can fail — an unwritable `$PASEO_HOME`, a full disk. Terminal creation catches that and opens the terminal without routing, logging a warning. A terminal that loses its gateway is recoverable; a terminal that will not open is not.

## Out of scope

- Pi: verified env-deaf. `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL` are ignored at inference (bogus endpoints still reach vendor APIs), the model list is a static bundled catalog, and custom endpoints require `models.json` in the agent dir — a config file. No `--config` overlay flag and no project-level `models.json` exist.
- Copilot: audited closed. All 65 CLI flags carry no endpoint option, `~/.copilot/config.json` holds first-launch state only, the binary's env keys are paths/update/home, and auth is device-flow. Models come from the Copilot service.
- ACP catalog (38 CLIs): no shared override surface. Each CLI owns its endpoint and auth, and most speak vendor-native protocols the Gateway does not serve. Paseo already passes provider `env` through to every ACP child process, so a CLI with a documented env override can be pointed per-provider today; there is nothing generic for first-party routing to inject.
- App settings UI for CLIProxyAPI: config file plus env only. The existing provider Refresh and Add Model flows cover discovery and manual entries.
