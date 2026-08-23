# Browser Localhost Routing

The in-app Browser has workspace-aware localhost routing on Electron desktop, Android, and web builds. When a Browser tab belongs to a workspace on host `H`, loopback URLs loaded inside that Browser are resolved against host `H`, not against the machine running the client.

This is separate from the service proxy. The service proxy exposes `paseo.json` service scripts through generated hostnames and optional public URLs. Browser localhost routing is for raw loopback URLs that a user or page enters directly, such as `http://localhost:5173`, `http://127.0.0.1:3000`, or a WebSocket opened to `ws://localhost:3000`.

## Routing scope

- Applies to Electron Browser panes and browser automation tabs, human-operated Android Browser panes, and web build Browser panes on hosts that advertise a preview template. Browser automation and DevTools remain Electron-only.
- Applies per Browser instance. Each Browser uses its own Electron session partition, so multiple Browser panes can point `localhost:3000` at different workspace hosts at the same time.
- Android's WebView proxy override is process-wide, so Android activates one selected host route at a time. Tabs for that host share it; switching hosts unmounts the previous host's WebViews, closes its tunnels, rotates proxy credentials, and reloads saved URLs when that host is selected again.
- Electron retains its existing loopback set: `localhost`, `*.localhost`, `127.*`, `::1`, `::`, and `0.0.0.0`. Android tunnels only standard loopback names and addresses (`localhost`, `*.localhost`, valid `127.*`, and `::1`); unspecified listen addresses are rejected. Explicit IPv6 loopback URLs are tunneled to `::1` on the host daemon; all other tunneled forms use `127.0.0.1`.
- Preserves the visible URL and page origin. The user still sees `localhost:<port>` in the Browser, and page code still observes the same origin it requested.
- Does not affect the system browser, the web app running in a normal browser, or service proxy generated URLs.
- Assistant chat, terminal, and workspace-script links keep rendering the original `localhost` URL. On Electron or a capable Android host, clicking one opens that original URL in the workspace Browser so this routing layer can handle it.
- Code Server tabs on Electron desktop reuse the Browser webview and this same localhost routing layer, but hide Browser chrome so the tab feels like an embedded editor.

## How it works

1. The renderer registers each Browser with Electron main using `{ browserId, serverId, workspaceId }`.
2. Electron main creates a loopback HTTP proxy for that Browser and applies it to the Browser's `persist:paseo-browser-${browserId}` session partition with loopback proxy bypass disabled. The proxy requires per-Browser Basic proxy auth; Electron main only supplies those credentials for the matching Browser webContents.
3. For non-loopback requests, the proxy connects directly to the requested host.
4. For loopback requests, the proxy asks the renderer to open a TCP tunnel on the Browser's registered `serverId`.
5. The renderer uses that host's existing daemon WebSocket client to open a binary TCP tunnel to the daemon.
6. The daemon connects to `127.0.0.1:<port>` or `::1:<port>` on its own machine and relays bytes over the WebSocket tunnel.

The tunnel protocol is a binary WebSocket frame family in `packages/protocol/src/binary-frames/tcp-tunnel.ts`. The daemon advertises support through `server_info.features.tcpTunnel`; old daemons do not get a fallback path. The UI-side tunnel controller checks this capability in one place and reports that the host must be updated.

### Android WebView routing

Android uses the app-local `paseo-browser-proxy` Expo module and AndroidX WebKit's process-wide proxy override. The module binds an authenticated HTTP proxy to a random `127.0.0.1` port, removes WebView's implicit loopback exclusion, and enables reverse bypass rules. `localhost`, `*.localhost`, valid `127.*` addresses, and `::1` are tunnel candidates; every ordinary non-loopback request bypasses the proxy and uses the phone's normal network stack. `0.0.0.0` and `::` are deliberately sent to the proxy only as fail-closed deny targets, never as host tunnel destinations.

Proxy bypass rule order is significant. Chromium evaluates the list from last to first, so AndroidX's negative `<-loopback>` rule from `removeImplicitRules()` must be added before the explicit loopback rules. If it is added last, it wins over those rules under reverse bypass and WebView silently connects to the phone's own localhost, typically surfacing `net::ERR_CONNECTION_REFUSED` (`WebViewClient.ERROR_CONNECT`, code `-6`).

The proxy accepts credentials only for its generated host and realm. It validates every destination, removes `Proxy-Authorization`, rewrites HTTP proxy absolute-form to origin-form, and opens `DaemonClient.openTcpTunnel` on the active host. Chromium uses `CONNECT` for proxied WebSockets, including plaintext `ws://`, so the native proxy acknowledges `CONNECT` and inspects the first tunneled bytes. Only a validated plaintext WebSocket Upgrade opens a daemon tunnel; a TLS ClientHello is closed before any tunnel-open event can reach JavaScript. WebSocket Upgrade requests then keep their connection for development servers and HMR. The app never installs a certificate, intercepts TLS, or weakens WebView certificate checks.

| Requested resource                      | Android route                                  |
| --------------------------------------- | ---------------------------------------------- |
| `http://localhost:<port>` and assets    | Selected Paseo host through the TCP tunnel     |
| `ws://localhost:<port>`                 | Selected Paseo host through the TCP tunnel     |
| Public/LAN `http://` or `https://`      | Device network, outside the Paseo proxy        |
| Third-party HTTPS from a localhost page | Device network with normal TLS validation      |
| `https://localhost` / `wss://localhost` | Rejected; never falls back to device localhost |
| `0.0.0.0` / `::` as URL destinations    | Rejected; use a standard loopback URL          |

Android requires both `PROXY_OVERRIDE` and `PROXY_OVERRIDE_REVERSE_BYPASS`. If the installed Android System WebView lacks either feature, Browser shows an update-WebView state instead of attempting a degraded route.

### Android lifecycle

- One root tunnel controller owns the active Android proxy. Browser tabs claim a host only while their workspace route is focused.
- Backgrounding stops the proxy and all open TCP streams. Returning creates a new authenticated session and reloads retained Browser panes.
- Host changes clear the old proxy override before the new route becomes usable. Native operation generations prevent a late start callback from replacing a newer route.
- Settings > General > Clear browser data clears WebView cookies, cache, DOM storage, form data, and live histories, then reloads Browser panes. It does not delete tab records or saved URLs.

## Web build

A web build Browser tab has no engine hook to install a proxy into — an `<iframe>` can only load URLs the user's own browser can reach, so `http://localhost:3000` typed into a web build resolves against the _user's_ machine, not the daemon's. Electron and Android solve this client-side, inside the browser engine; the web build cannot, so the daemon solves it instead by serving an origin per loopback port and reverse-proxying it.

```
browser ──HTTP/WS──> 3000--daemon-1.studio.example.com
                       └─> daemon (Host-matched) ──> 127.0.0.1:3000
                                                     Host: localhost:3000
```

An inbound `Host` header matching a configured hostname template is forwarded to `127.0.0.1:<port>` on the daemon's own machine, with `Host` forged back to `localhost:<port>` so the dev server sees an ordinary loopback request — Vite host checks, cookie domains, and CORS behave as they do locally. WebSocket upgrades are proxied the same way, so HMR needs no special handling. There is no Service Worker, no injected script, and no client-side state; the app only ever substitutes `{port}` into a template it already received on `server_info`.

### Configuration

Set a hostname template with exactly one `{port}` placeholder in the **hostname** (not the path or query), either under `daemon.browserPreview.urlTemplate` in `~/.paseo/config.json` or as `PASEO_BROWSER_PREVIEW_URL_TEMPLATE` (the environment variable wins, matching `serviceProxy`'s own env-over-config precedent). One template covers both deployment shapes:

```json
// dedicated wildcard — the common case
{
  "version": 1,
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
  "version": 1,
  "daemon": {
    "browserPreview": {
      "urlTemplate": "https://{port}--daemon-1.studio.example.com"
    }
  }
}
```

An invalid template — a missing or repeated placeholder, a placeholder outside the hostname, or a label that would exceed DNS's 63-character limit once a five-digit port is substituted — fails daemon startup with a clear error instead of silently not working. Unlike service-proxy's generated hostnames, which shorten an over-long label with a hash suffix, an over-long preview label is rejected outright: truncating would silently serve a hostname the operator's own DNS was never configured for.

**Configuring this makes every loopback port on that machine reachable by anyone who can resolve the hostname** — not only dev servers, and not only the ports a `paseo.json` service script explicitly registers. A preview request is classified and forwarded ahead of both the host allowlist and daemon password auth (like [service proxy](service-proxy.md) routes, a matched request never calls `next()`), so it gets neither check. This follows the existing precedent that daemon password authentication protects daemon APIs but not proxied dev services (see [Service Proxy](service-proxy.md)) — but that precedent was set for named, enumerable service routes; a preview template resolves _any_ port a client's `Host` header names. This is a deliberate v1 tradeoff, documented rather than gated: operators fronting a fleet should require auth at the ingress.

Wildcard DNS for the template's hostname pattern must point at the daemon's machine. There is no separate `browserPreview.listen` — whatever reverse proxy fronts the daemon's main listener has to route this pattern too, and it must preserve `Host` unchanged: `Host` is the routing key preview parses to recover the port, not incidental metadata.

```nginx
server {
    listen 443 ssl;
    server_name *.preview.example.com;

    location / {
        proxy_pass http://10.1.1.1:6767;
        proxy_set_header Host $http_host;
    }
}
```

Use `$http_host`, not `$host` — `$host` drops the port (see service-proxy's own [DNS and reverse proxy setup](service-proxy.md#dns-and-reverse-proxy-setup)).

Each daemon renders its own identity into its own template and advertises it on `server_info.browserPreview.urlTemplate`; the app never reads `PASEO_BROWSER_PREVIEW_URL_TEMPLATE` itself. A mixed fleet therefore needs no client-side configuration — each tab substitutes `{port}` into whichever host it belongs to. A relay host advertises no template and Browser shows its existing unavailable state; relay support is out of scope for this version.

### Fork rationale

This is a fork that merges upstream every release. The preview module is shaped to survive that without becoming a merge conflict, in the same spirit as the Electron partition rationale under Browser profile compatibility below:

- **Classification rides Express mount order, not a branch in `classifyHost`.** `browserPreview.middleware()` is mounted ahead of `serviceProxy.middleware()` (`bootstrap.ts:677` and `:682`). A matched request never calls `next()`, so it never reaches `classifyHost`'s `known-service-miss` branches, which would otherwise 404 a preview host that happens to fall under a configured public base. `service-proxy.ts` stays unedited apart from exporting two existing helpers.
- **The forwarding policy is owned, not shared.** Service routes pass `Host` and `X-Forwarded-*` through; preview inverts both, forging `Host` to `localhost:<port>` and dropping `X-Forwarded-*` so the dev server sees what looks like a direct loopback hit. Threading a policy parameter through `proxyHttpRequest`, `proxyUpgradeRequest`, and `buildForwardedHeaders` to share that code would be the more invasive change, so `packages/server/src/server/browser-preview/` owns its own forwarding instead.
- **Preview hosts bypass the host allowlist by construction, exactly as service routes do.** The allowlist middleware (`bootstrap.ts:687`) only runs when a request reaches it via `next()`, and a handled preview request never does. No `hostnames`/`allowedHosts` entry is needed for the preview hostname pattern.

A fourth constraint surfaced once WebSocket upgrades were wired up. `ws`'s `{ server, path: "/ws" }` attachment installs its own `upgrade` listener that synchronously aborts any request whose path isn't `/ws` — including one another listener already started an async claim on, destroying the socket out from under it before a preview dial could complete, which made HMR impossible. `createWebSocketServer` now attaches with `noServer: true` and exposes `handleUpgrade()` (`websocket-server.ts:813`); `bootstrap.ts` offers each socket to preview, then `/ws`, then the service proxy in one explicit router (`bootstrap.ts:840`), so no listener can abort a claim another intends to make. This incidentally fixed the same race for registered `paseo.json` service WebSocket routes, which predate preview and shared the same failure mode.

Only `normalizeHostHeader` and `stripHopByHopHeaders` are imported from `service-proxy.ts`, one `export` keyword each: host parsing has to agree with `classifyHost`'s own parsing, and hop-by-hop headers are an HTTP fact that would rot if copied. Everything else — the proxy, the template parser, the response rewriter — is fork-owned in `packages/server/src/server/browser-preview/`.

### Known limitations

- **The address bar does not follow in-page navigation.** A cross-origin `<iframe>` emits no navigation events to its parent, so once a page navigates itself — a client-side route change, a redirect — Paseo's address bar keeps showing the last URL it set. Electron's `<webview>` exposes navigation events; a plain `<iframe>` does not, and there is no clean fix.
- **A port already exposed as a service-proxy route is reachable at two origins.** If a `paseo.json` service script and a manually opened Browser tab point at the same port, the service hostname and the preview hostname are different origins with separate cookie jars — signing in on one does not carry over to the other. This is intended: [service proxy](service-proxy.md) routes and preview routes serve different purposes, and neither is aware of the other's routes.

## Code Server

Hosts may advertise optional Code Server openers in `server_info.urlOpeners.codeServer`.

- `localhostUrl` is derived from a running daemon-local code-server process, such as `http://127.0.0.1:13337`. Electron desktop shows a Code Server action when this is present. Clicking it creates a dedicated Code Server workspace tab that internally uses a Browser webview with hidden chrome.
- `externalUrl` comes from `CODE_SERVER_URL` when it is set to an absolute `http` or `https` URL. Web and native platforms open it in the external browser. When that URL is loopback, or when only `localhostUrl` is available, the client can derive the mobile URL from `VSCODE_PROXY_URI` instead of opening the phone's own localhost.
- Code Server launch URLs include the current workspace directory in the `folder` query parameter so the editor opens the selected workspace by default.
- Code Server workspace tabs have their own local title records (`Code Server 1`, `Code Server 2`, etc.) and can be renamed from the tab menu. They are not generic Browser tabs, even though desktop uses Browser infrastructure internally.

## Invariants

- The client sends only a port plus a loopback-family enum to the daemon. Hostname normalization happens in Electron main, and the daemon only dials `127.0.0.1` or `::1`.
- Browser panes delay their first navigation until workspace Browser registration finishes, so the initial `localhost` load uses the correct session proxy.
- Browser automation registers the Browser before creating its resident webview for the same reason.
- Do not route Browser localhost through generated service-proxy hostnames. That would change the visible origin and break pages that expect `localhost`.
- Normal HTTP proxy requests force `Connection: close` after the rewritten request. This makes Chromium open a fresh proxy connection for later Vite module requests, so every request is parsed and rewritten from proxy absolute-form to origin-form. WebSocket upgrade requests keep their upgrade connection for HMR.

## Browser profile compatibility

The fork intentionally keeps Browser webviews on `persist:paseo-browser-${browserId}` partitions even though upstream Browser tabs can use one shared profile. Electron proxy settings are session-scoped, so moving fork webviews onto a single shared partition would make every tab use whichever workspace proxy registered last and silently route `localhost` to the wrong host.

Upstream's attached-webview identity checks and profile cleanup still apply to these prefixed partitions. Do not collapse them into the shared `persist:paseo-browser` partition unless the remote-localhost proxy is first redesigned so concurrent tabs on different hosts remain isolated.

## Testing

Use focused tests for the protocol codec and daemon forwarder:

```bash
npx vitest run packages/protocol/src/binary-frames/tcp-tunnel.test.ts packages/protocol/src/binary-frames/demux.test.ts --bail=1
npx vitest run packages/server/src/server/tcp-tunnel-forwarder.test.ts --bail=1
```

For full Electron behavior, use a real Browser pane or browser automation tab because the important behavior depends on Electron session proxying and webview partitions.

Android request parsing has Kotlin unit coverage in the local Expo module. `.github/workflows/ci.yml` runs those tests and a one-worker debug assembly only when Android Browser paths change. Do not use local Expo prebuild, Gradle, emulator, Maestro, APK, or AAB builds as routine verification for this feature; use focused JS tests plus formatting, lint, and typecheck locally, and leave native compilation and device validation to GitHub Actions or the cloud release workflow.

Web build routing has unit coverage in the fork-owned proxy module and the app-side URL resolver:

```bash
npx vitest run packages/server/src/server/browser-preview/index.test.ts packages/server/src/server/browser-preview/url-template.test.ts packages/server/src/server/browser-preview/response-headers.test.ts packages/server/src/server/browser-preview/bootstrap-mount.test.ts packages/server/src/server/config-browser-preview.test.ts --bail=1
npx vitest run packages/app/src/desktop/browser/pane/web-preview-url.test.ts packages/app/src/desktop/browser/workspace-browser-availability.test.ts packages/app/src/desktop/browser/workspace-browser-preview.test.ts --bail=1
```
