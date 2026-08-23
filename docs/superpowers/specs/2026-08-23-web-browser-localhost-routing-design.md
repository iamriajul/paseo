# Web build Browser localhost routing — design

**Date:** 2026-08-23
**Status:** Approved for implementation planning
**Scope:** Give the in-app Browser working `localhost:<port>` routing in the web build, for daemons the user's browser can reach over HTTP. A Browser tab bound to a workspace on host `H` resolves loopback URLs against `H`, using a daemon-side reverse proxy addressed by a configurable hostname template.

## Problem

[Browser Localhost Routing](../../browser-localhost-routing.md) works on Electron desktop and Android. Both rely on installing a proxy _into the browser engine_: Electron applies a per-`browserId` proxy to a session partition, Android uses AndroidX WebKit's process-wide proxy override.

A normal web browser exposes no such hook. `packages/app/src/desktop/browser/pane/index.web.tsx` is a placeholder that renders `workspace.browser.unavailable.title`, and `resolveWorkspaceBrowserAvailability` returns `false` for web.

An `<iframe>` can only load URLs the user's own browser can reach, so `http://localhost:3000` in a web build resolves to the _user's_ machine, not the daemon's. The web build needs a reachable origin that maps to `(daemon, loopback port)`.

## Goals

- Typing or clicking `localhost:<port>` in a web-build Browser tab loads that port on the tab's daemon.
- The dev server sees `Host: localhost:<port>` — its receiving origin is preserved, so Vite host checks, cookie domains and CORS behave as they do locally.
- Paseo's Browser chrome keeps displaying `localhost:<port>`.
- HMR works.
- Multiple daemons at once, each with its own preview origin.
- Deployment shapes are configurable, covering both a dedicated wildcard and an orchestrated fleet sharing one wildcard.

## Non-goals

- **Relay hosts.** Deferred to v2; see [v2 seam](#v2-seam). A relay host advertises no template and shows the existing unavailable state.
- Electron and Android, which keep their existing engine-level proxies unchanged.
- Browser automation and DevTools, which stay Electron-only.
- Changing service-proxy behaviour for `paseo.json` script routes.

## Options considered

**Service Worker on a preview origin, bytes over the daemon WebSocket.** The only mechanism that can work for relay hosts, since the relay carries nothing but E2EE frames. Rejected for v1 on cost: it needs a `clientId → token` registry persisted to IndexedDB, an injected `history.replaceState` shim so SPA routers still match their own routes, a `WebSocket` shim because Service Workers cannot intercept WebSocket, and a bootstrap round on reload. It also requires HTTPS, since Service Workers demand a secure context. Recorded as v2.

**Path prefix on the app's own origin, no Service Worker.** Rejected on mechanics. Root-absolute subresources — `/@vite/client`, `/@react-refresh`, `/node_modules/.vite/deps/*` — discard the prefix, arrive with `Origin: null` and no usable `Referer`, and cannot be correlated to a target. `<base href>` does not redirect root-absolute URLs.

**Registering preview routes in `ServiceProxyRouteRegistry`.** Rejected. Service routes are _registered_ and carry identity (`workspaceId`, `projectSlug`, `scriptName`) plus a lifecycle tied to the script. Preview routes are _derived_ — a pure function of the `Host` header, with no identity and no bound on how many a user can produce. Three subsystems read that registry: `script-health-monitor.ts:62,96,189` would poll every port a user typed, `script-status-projection.ts:89` would attribute them to scripts, and `script-route-branch-handler.ts:14` would rewrite routes that have no branch.

**Nested wildcard per daemon** (`*.daemon-1.studio.example.com`). Rejected: TLS wildcards match a single label, and an orchestrated fleet already spends its one wildcard on `*.studio.example.com`.

## Architecture

The daemon serves an origin per loopback port and reverse-proxies it. No Service Worker, no injected script, no shims — a WebSocket upgrade is proxied natively, so HMR needs nothing special.

```
browser ──HTTP/WS──> 3000--daemon-1.studio.example.com
                       └─> daemon (Host-matched) ──> 127.0.0.1:3000
                                                     Host: localhost:3000
```

### Hostname template

One config knob with a single `{port}` placeholder covers both deployment shapes:

```json
// dedicated wildcard — the common case
{
  "daemon": {
    "browserPreview": {
      "urlTemplate": "https://{port}.preview.example.com"
    }
  }
}
```

```json
// one daemon in an orchestrated fleet sharing *.studio.example.com
{
  "daemon": {
    "browserPreview": {
      "urlTemplate": "https://{port}--daemon-1.studio.example.com"
    }
  }
}
```

Each daemon renders its own identity into its own template at config time, so nothing is inferred and nested wildcards never arise.

**Who reads it.** The daemon, and only the daemon. `resolveBrowserPreviewConfig(env, persisted)` in `config.ts` mirrors `resolveServiceProxyConfig` (`config.ts:277`): `PASEO_BROWSER_PREVIEW_URL_TEMPLATE` wins, `persisted.daemon?.browserPreview?.urlTemplate` is the fallback, and an invalid value throws `Invalid PASEO_BROWSER_PREVIEW_URL_TEMPLATE: <value>` to match the convention at `config.ts:272`. It is called from the main resolver alongside `resolveServiceProxyConfig` (`config.ts:506`), lands on the resolved config, and reaches the subsystem at the point where `bootstrap.ts:627` already reads `serviceProxy.publicBaseUrl`.

**The app never reads this variable.** Clients learn the template from `server_info`; see [Capability advertisement](#capability-advertisement). If the app read the environment instead, a single template would serve every connected daemon — precisely the failure that per-host advertisement exists to prevent.

**Make its loss loud.** The resolved field is required on the config type, not optional. If the call site is dropped while resolving an upstream merge, `npm run typecheck` fails instead of the feature silently losing its configuration. Same rule as the imports in [Fork constraints](#fork-constraints).

**Validation**, applied at config load, failing startup with a clear message:

- `{port}` appears exactly once.
- The template parses as an absolute `http`/`https` URL once `{port}` is substituted.
- `{port}` falls inside the **hostname**, not the path, query or userinfo. A path-based template reintroduces the root-absolute-subresource failure that ruled out the path-prefix option, so it is rejected rather than left to half-work.
- The label containing `{port}` is at most 63 characters with a five-digit port substituted. Reject rather than truncate: `capDnsLabel` (`service-proxy.ts:113`) exists to shorten generated slugs with a hash suffix, and silently rewriting an operator's template would yield a hostname their DNS does not serve.

**Parsing** reverses the template. Precompute the literal prefix and suffix around `{port}` from the template's hostname; an inbound `Host`, normalised and stripped of its port, matches when it starts with the prefix, ends with the suffix, and has only digits between — parsed as an integer in `1..65535`.

```
"https://{port}--daemon-1.studio.example.com"
  → prefix ""   suffix "--daemon-1.studio.example.com"
"https://{port}.preview.example.com"
  → prefix ""   suffix ".preview.example.com"
```

### Host allowlist

`isHostnameAllowed` (`hostnames.ts`) defaults to `localhost`, `*.localhost` and literal IPs, so a preview hostname is not in the default set. **No hostname configuration is required regardless**, because preview requests never reach the check.

The allowlist middleware is registered at `bootstrap.ts:669`, _after_ `app.use(serviceProxy.middleware())` at `:666`. Express runs middleware in order and a proxied request never calls `next()`, so it never reaches validation — which is why registered service routes work today without appearing in `hostnames`. Preview middleware mounts ahead of the service proxy and inherits the same property. The upgrade path behaves the same way: `websocket-server.ts:869` validates the host, but `bootstrap.ts:812` claims matching sockets before the WebSocket server attaches its listener.

This narrows rather than widens DNS-rebinding exposure. Only hosts matching the operator-configured template bypass the check; everything else falls through to `next()` and is validated exactly as before.

### Classification by mount order

Preview must resolve _above_ the `known-service-miss` branches in `classifyHost` (`service-proxy.ts:622`), which would otherwise swallow preview hosts: the `.localhost` branch catches any first label containing `--`, and the `publicBaseHostnames` loop catches everything under a configured service base.

Express mounting order achieves that without touching `classifyHost`:

```
app.use(browserPreview.middleware())   // added at bootstrap.ts:665
app.use(serviceProxy.middleware())     // existing   bootstrap.ts:666
```

Preview hosts are handled first; everything else calls `next()` and reaches the service proxy unchanged. The upgrade handler registers before `bootstrap.ts:812` for the same reason — the existing service handler runs with `passthroughUnknown: true`, so it returns without destroying sockets it does not recognise.

### Forwarding policy

Deliberately the inverse of the service policy on every axis that matters:

|                                           | Service route  | Preview route                                                                  |
| ----------------------------------------- | -------------- | ------------------------------------------------------------------------------ |
| Upstream `Host`                           | passed through | **`localhost:<port>`**                                                         |
| `X-Forwarded-*`                           | set            | **not set** — look like a direct loopback hit                                  |
| Request `origin`                          | passed through | stripped                                                                       |
| Response CSP / `X-Frame-Options`          | passed through | stripped, so the page can be framed                                            |
| `Location`, `Content-Location`, `Refresh` | passed through | rewritten onto the preview origin when they point at loopback on the same port |
| WebSocket upgrade                         | proxied        | proxied                                                                        |

Upstream dial order is `127.0.0.1`, falling back to `::1` on `ECONNREFUSED`, so a dev server bound only to IPv6 loopback still resolves.

## Fork constraints

This is a fork that merges upstream every release (`git log --grep="official Paseo"`: v0.2.3 through v0.4.0). Merge surface is a design constraint. The rule applied throughout: **import facts, own policy**, and make anything whose loss would be silent fail loudly instead.

**Import from `service-proxy.ts`** — one-line `export` each (two helpers; `capDnsLabel` is deliberately not among them, see Validation above). If an export is dropped resolving a conflict, `npm run typecheck` fails at the import site.

| Helper                 | Line | Why not copy                                                                               |
| ---------------------- | ---- | ------------------------------------------------------------------------------------------ |
| `normalizeHostHeader`  | 94   | Host parsing must agree with `classifyHost`, or the two disagree about what a `Host` means |
| `stripHopByHopHeaders` | 247  | A fact about HTTP that upstream keeps current; a copy rots silently                        |

**Own, in a fork-owned module.** `proxyHttpRequest` (318), `proxyUpgradeRequest` (358) and `buildForwardedHeaders` (273) bake the service policy in and would each need a policy parameter threaded through signature and body to share — the invasive refactor this design avoids. Their correctness for preview is defined by the policy table above, not by upstream, so divergence is intended rather than drift.

**Do not** extract or relocate anything inside `service-proxy.ts`. Moving upstream code conflicts on every sync, inside the relocated region.

**Upstream files touched:** `bootstrap.ts` (two mount lines), `config.ts` (one resolver plus its call site, with the resolved field required so a dropped call fails typecheck), `persisted-config.ts` (one optional nested key), protocol `server_info` (one optional field), `pane/index.web.tsx` (whole-file replacement of a placeholder), `workspace-browser-availability.ts` (one branch, already fork-modified), and a new per-host selector beside `host-features.ts`. `docs/service-proxy.md` is upstream and is linked, never edited.

## Capability advertisement

```
server_info.browserPreview.urlTemplate = "https://{port}--daemon-1.studio.example.com"
```

**One field, not a flag plus a field.** A valid `urlTemplate` _is_ the capability. An earlier draft also advertised `features.browserPreview`, which let a daemon claim support while omitting the template — the client would then open a Browser tab with no origin to point it at. A single field cannot contradict itself.

This keeps the intent of the [protocol-compatibility](../../protocol-compatibility.md) rule — gate once, no defensive branches — while putting the gate on required data rather than a parallel boolean. On the wire the field stays optional and additive. A host that advertises nothing gets no fallback path.

The app substitutes `{port}` into the template of _the tab's own host_, so a mixed fleet needs no client-side origin matching: each direct daemon advertises its own template, and a relay daemon advertises none. If upstream later ships its own `browserPreview` with different semantics, the collision is semantic rather than textual and will not surface as a merge conflict.

## App behaviour

`resolveWorkspaceBrowserAvailability` gains a web branch **after** the existing `isElectron` short-circuit — Electron also reports `Platform.OS === "web"` and must keep returning `true` unconditionally. `pane/index.web.tsx` renders an `<iframe>` whose `src` is the substituted template.

**Reading the template needs a new selector.** `useHostFeature` answers `boolean` only (`serverInfo?.features?.[feature] === true`), so it cannot carry a string. Add a sibling selector over `sessions[serverId].serverInfo.browserPreview?.urlTemplate`, keyed per `serverId` like the existing hooks, returning the template or `null`. Availability for web is then simply "the selector returned a template", which keeps one source of truth end to end.

URL handling in the Browser address bar:

- `localhost`, `127.0.0.1` and `[::1]` with a port are preview candidates and route through the template.
- `0.0.0.0` and `::` are rejected as destinations, matching Android.
- Non-loopback URLs load in the iframe directly, as ordinary web pages.

**Two distinct unavailable states.** Availability is per platform _and_ per host, so the copy has to say which one applies. A daemon with no template still has a fully working Browser on Electron desktop and Android, which take a different route entirely — a flat "unavailable" leads a user who sees it working on their desktop to conclude the web build is broken.

- Platform cannot support it at all → the existing generic message.
- Web build, host advertises no template → name the host and the setting (`browserPreview.urlTemplate`) so the message is actionable, mirroring how Android surfaces an update-WebView state rather than a generic failure.

**Known limitation.** A cross-origin iframe emits no navigation events to its parent, so if the page navigates itself the address bar keeps showing the last URL Paseo set. Electron's `<webview>` exposes these events; `<iframe>` does not. Document it so it is not mistaken for a bug.

## Security posture

A preview route resolves **any** loopback port, so anyone who can reach the template's hostname gets unauthenticated access to every port on that machine — not only dev servers. This follows the precedent in [service-proxy](../../service-proxy.md) ("Daemon password authentication protects daemon APIs; it does not protect proxied dev services"), but that precedent was set for named, enumerable routes.

v1 documents rather than gates, and the template design keeps a gate additive. Operators fronting a fleet with an ingress should require auth there, which is a better placement than the daemon. The docs must state the exposure plainly at the point where `urlTemplate` is introduced.

## Testing

Per [testing](../../testing.md) and the repo rule against broad local suites, run only the files touched.

Unit coverage in the fork-owned module: template validation, including rejection of path-positioned `{port}`, of a missing or repeated placeholder, and of an over-long label; prefix/suffix parsing, including near-miss hosts and out-of-range ports; response header rewriting for `Location`, `Content-Location` and `Refresh`, covering relative values, non-loopback values, and a loopback value on a different port, which must all pass through untouched; parent-domain derivation for the hostname merge.

**Anchor tests.** The two `bootstrap.ts` mount lines, the config key and the `server_info` field fail silently if lost in a merge — typecheck still passes. A test using the in-process daemon harness from [ad-hoc-daemon-testing](../../ad-hoc-daemon-testing.md) boots a daemon with a template configured, asserts a preview `Host` reaches a loopback listener with `Host: localhost:<port>`, and reads the advertised template back through `server_info`. Configure through the real config key so the whole chain is covered.

## Docs

Extend `docs/browser-localhost-routing.md` with a web section, alongside the existing Electron and Android sections; do not start a new file. Include the fork rationale in the same voice as the existing "Browser profile compatibility" section, explaining that classification rides mount order and that the forwarding policy is owned rather than shared, so a future sync does not "clean up" either into `service-proxy.ts`. Add the port-exposure warning where `urlTemplate` is introduced. Link to `docs/service-proxy.md` for the distinction between script routes and preview routes.

## v2 seam

Relay hosts advertise no template today and show unavailable. v2 adds a transport rather than reworking this design: a Service Worker on a preview origin, with request bytes carried over the app's existing E2EE WebSocket and a daemon-side HTTP/WebSocket bridge. The pieces it needs — `clientId → token` registry in IndexedDB, injected `replaceState`, a `WebSocket` shim, HTTPS — are documented above under Options considered. Nothing in v1 blocks it: the capability flag already distinguishes hosts, and the app already selects behaviour per host.
