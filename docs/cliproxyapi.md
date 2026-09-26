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

`baseUrl` accepts the Claude form (`http://cliproxyapi-host:8317`) or the Codex/OpenCode form with a `/v1` suffix; Paseo normalizes it and appends `/v1` where a harness needs it. `PASEO_CLIPROXYAPI_BASE_URL` and `PASEO_CLIPROXYAPI_API_KEY` override the file when set, and either one enables CLIProxyAPI without the flag. `agents.gateway` and `PASEO_GATEWAY_*` still load, so an existing file keeps working.

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
- Those CPA limits are applied to the running client immediately. A failed config write no longer drops a discovered model back to Claude Code's 200k default.
- Custom non-family models pin the five family/subagent vars (`ANTHROPIC_DEFAULT_*_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`) to the selected model. User-set values win; first-party models are untouched.
- Gateway-routed custom models get `WebSearch` appended to disallowed tools: the Gateway does not serve that Anthropic server-side tool for non-Anthropic models. First-party rows keep it.
- Image attachments check known `inputModalities`: a model known to be text-only gets a local-file path hint instead of image blocks. Unknown modalities keep forwarding images.
- Mid-session switches the SDK control plane rejects (`Couldn't confirm model ...`) relaunch the query on the resumed session with the new model.

Deliberately not imported: Codex reasoning ceilings (they under-cap Claude Code — Grok `max` works there), per-model effort restrictions, Fast mode for non-manifest models, `[1m]` variant synthesis, and `supportedModels()` control-plane reads.

## Quota

The composer meter tooltip shows per-model CLIProxyAPI quota for the agent's selected model through the `gateway.quota.get` RPC (gated on `server_info.features.cliproxyapiQuota`). The daemon maps the Paseo model id to the CLIProxyAPI slug — raw for Claude (wire form decoded, `[1m]`/thinking suffixes stripped), bare for Codex, `cliproxyapi/` and `litellm/` prefixes stripped for OpenCode and OMP — and only queries when that provider is CLIProxyAPI-routed. Results cache for 60 seconds.

CLIProxyAPI builds that predate `/v1/quota` answer 404 with an empty body (observed live); current builds answer errors with a JSON envelope. Anything but a valid quota payload — missing route, unknown model, bad key, unparseable body, transport failure — returns `supported: false` and the tooltip hides the section instead of showing an error.

## Out of scope

- Pi: verified env-deaf. `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL` are ignored at inference (bogus endpoints still reach vendor APIs), the model list is a static bundled catalog, and custom endpoints require `models.json` in the agent dir — a config file. No `--config` overlay flag and no project-level `models.json` exist.
- Copilot: audited closed. All 65 CLI flags carry no endpoint option, `~/.copilot/config.json` holds first-launch state only, the binary's env keys are paths/update/home, and auth is device-flow. Models come from the Copilot service.
- ACP catalog (38 CLIs): no shared override surface. Each CLI owns its endpoint and auth, and most speak vendor-native protocols the Gateway does not serve. Paseo already passes provider `env` through to every ACP child process, so a CLI with a documented env override can be pointed per-provider today; there is nothing generic for first-party routing to inject.
- App settings UI for CLIProxyAPI: config file plus env only. The existing provider Refresh and Add Model flows cover discovery and manual entries.
