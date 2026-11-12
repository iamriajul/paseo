# Browser Localhost Routing

The in-app Browser has workspace-aware localhost routing on Electron desktop, Android, and web builds. When a Browser tab belongs to a workspace on host `H`, loopback URLs loaded inside that Browser are resolved against host `H`, not against the machine running the client.

With a host's experimental server browser on, workspace URLs open in a headless Chromium on the host instead, where loopback needs no routing; see [Server browser](server-browser.md).

This is separate from the service proxy. The service proxy exposes `paseo.json` service scripts through generated hostnames and optional public URLs. Browser localhost routing is for loopback URLs such as `http://localhost:5173`, `http://127.0.0.1:3000`, or a WebSocket opened to `ws://localhost:3000`. Inside the Browser, `paseo.json` services ride this route too; see [Workspace services in the Browser](#workspace-services-in-the-browser).

## Routing scope

- Applies to Electron Browser panes and browser automation tabs, human-operated Android Browser panes, and web build Browser panes on hosts that advertise a preview template. Browser automation and DevTools remain Electron-only.
- Applies per workspace. Browser tabs of one workspace share an Electron session partition and its proxy; tabs of different workspaces use different partitions, so two workspaces on different hosts can each point `localhost:3000` at their own host at the same time. See [Browser profile compatibility](#browser-profile-compatibility).
- Android's WebView proxy override is process-wide, so Android activates one selected host route at a time. Tabs for that host share it; switching hosts unmounts the previous host's WebViews, closes its tunnels, rotates proxy credentials, and reloads saved URLs when that host is selected again.
- Electron retains its existing loopback set: `localhost`, `*.localhost`, `127.*`, `::1`, `::`, and `0.0.0.0`. Android tunnels only standard loopback names and addresses (`localhost`, `*.localhost`, valid `127.*`, and `::1`); unspecified listen addresses are rejected. Explicit IPv6 loopback URLs are tunneled to `::1` on the host daemon; all other tunneled forms use `127.0.0.1`.
- Preserves the visible URL and page origin. The user still sees `localhost:<port>` in the Browser, and page code still observes the same origin it requested.
- Does not affect the system browser, the web app running in a normal browser, or service proxy generated URLs.
- Links keep rendering the original `localhost` URL. On Electron or a capable Android host, clicking one anywhere in a workspace opens it in the workspace Browser so this routing layer can handle it. Every link surface goes through `useWorkspaceLoopbackOpener` (`packages/app/src/hooks/use-workspace-loopback-opener.ts`): chat messages pass it per message, and the workspace screen gives it to the workspace-level `AssistantFileLinkResolverProvider`, which covers question cards, plan and permission cards, file previews and sheets. A markdown surface outside both providers sends loopback links to the system browser, which is the bug this replaced: question-card links used to open externally.
- Code Server tabs on Electron desktop reuse the Browser webview and this same localhost routing layer, but hide Browser chrome so the tab feels like an embedded editor.

## How it works

1. The renderer registers each Browser with Electron main using `{ browserId, serverId, workspaceId }` before the first real navigation. Human-operated panes start on `about:blank`, wait for that IPC, then `loadURL`. Automation registers, then creates the resident webview.
2. Electron main creates a loopback HTTP proxy for the Browser's workspace and applies it to the workspace's `persist:paseo-browser-workspace-${workspaceId}` session partition with loopback proxy bypass disabled. The proxy requires Basic proxy auth; Electron main answers the challenge only for a guest whose session is that partition's session. If the tab's host is this machine, loopback connects directly on this machine instead of opening a workspace TCP tunnel.
3. For non-loopback requests, the proxy connects directly to the requested host.
4. For loopback requests on a remote host, the proxy asks the renderer to open a TCP tunnel on the Browser's registered `serverId`.
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

## Failures and recovery

A Browser tab never shows an empty surface without saying why. Electron draws nothing for a failed load: no error page, just the transparent guest, which reads as a black tab in dark themes. Before this, the common case was an agent calling `browser_new_tab` right after starting a dev server. The tab loads in a parked resident webview before any pane listens, the first load fails with `ERR_CONNECTION_REFUSED`, nobody records it, and the pane that mounts later reuses the resident without reloading because its `src` is already set. The tab stayed black until the user pasted the URL into a new tab.

What handles each failure:

| Failure                                          | Where                                                                                     | What the user sees                                                                                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main-frame load fails (refused, reset, DNS, TLS) | `did-fail-load` in the pane, or recorded by `resident-webviews.ts` before the pane mounts | `BrowserLoadFailure` card over the webview with Retry; connection-type errors retry by themselves with backoff (2 s doubling to 30 s) while the tab is visible |
| Guest renderer crashes                           | `render-process-gone` in the pane                                                         | Same card, "This page crashed", Retry reloads                                                                                                                  |
| Workspace tunnel cannot open (remote host)       | loopback proxy, `buildProxyFailureResponse`                                               | A page from the proxy naming the port and the reason, retrying itself with backoff; subresource and WebSocket failures stay an empty 502                       |
| Host connection drops and returns                | `useHostRuntimeIsConnected` in the pane                                                   | A tab showing a failure retries at once on reconnect                                                                                                           |

The webview surface paints above the app, so the pane parks it while the card is up and presents it again on retry.

Two attach races also produced blank or broken agent tabs, and both are covered by tests:

- `getWebContentsId()` can throw at `did-attach`, most often in a hidden or background window, and becomes readable a few hundred milliseconds later. A did-attach without an id retries on a 50 ms timer until registration lands. Retrying only at the next lifecycle event was the earlier fix, for the uncaught throw that left a tab unregistered. It was enough while those events came quickly. On a slow first page (a dev server compiling the route, a tunnel), the next event waits for the server, and `browser_new_tab` gave up after its 5 s registration wait. A retry then succeeded because the server had warmed up.
- The guest's first proxied request can reach the proxy before the renderer's `register-attached` IPC maps its webContents. Proxy credentials are matched by the guest's session partition, not only by the registered browserId.

Whether a host is this machine is remembered per `serverId` once any registration says so. The automation handler knows the connection and declares it; the pane registering the same tab does not, and the cached daemon status can be empty. Flipping that workspace's session from direct to the tunnel proxy ran `closeAllConnections()` mid-load.

## Open on this computer

A Browser tab or [server browser](server-browser.md) tab showing a localhost URL on a remote host has an "Open on this computer" toolbar menu (Electron desktop). It forwards the tab's ports to the machine running the desktop app and opens the page in the system browser.

- The port set is the address bar's port, every loopback port the page's own traffic used (documents, scripts, fetch/XHR, WebSockets), and ports the user adds. Forwarding only the page port leaves an app half-working when it calls an API or HMR socket on another port. A Browser tab's traffic is recorded in Electron main by `browser-loopback-traffic.ts` from `session.webRequest.onSendHeaders`. A server tab's page runs on the host, so the daemon records it from CDP `Network` events (`server-browser/loopback-ports.ts`) and the menu asks for it with `browser.server.tab.loopback_ports` (gated on `features.serverBrowserLoopbackPorts`; an older host gets the page port and hand-added ports only).
- Each forward is a listener on `127.0.0.1:<same port>` in Electron main (`browser-port-forward.ts`). Every accepted connection rides the same renderer TCP tunnel as Browser localhost, so it needs no new protocol and works wherever the tab's localhost works. A Browser tab's route comes from its loopback proxy registration; a server tab has no webview on this machine, so the renderer names its host when it starts the forwards, and Electron main keeps that route until they stop.
- Same port numbers keep absolute URLs working. A port already taken on this machine is reported as in use; "Use free ports instead" binds a random port, and the menu says pages that hard-code a port may break.
- Forwards belong to the tab. A Browser tab's stop when its webview unregisters. A server tab's stop when the host's tab list drops it (closed by anyone, crashed, the server browser turned off) or marks it `suspended` (`port-forward/server-tab-forwards.ts`, run on every tab update), and when the window that started them closes. A tab whose host is this machine needs no forward: the menu opens the URL directly.

### On a phone

Android has it for server browser tabs, as "Open on this phone". Through v0.15.912 no phone had it: the user's browser is another app, and switching to it backgrounds Paseo, where Android froze the process and its WebSocket. A foreground service now keeps Paseo running exactly while a forward is open.

- **Listeners.** `PortForwardListeners.kt` in the `paseo-browser-proxy` module binds each port on the phone's `127.0.0.1` at the same number (free-port fallback as on desktop) and hands every accepted socket to JS, reading nothing until JS has opened its daemon TCP tunnel. Ports, tunnels and lifetime live in `port-forward/mobile-port-forwards.ts`, which is unit-tested; the native layer only binds and moves bytes.
- **Foreground service.** `PortForwardService.kt` runs while at least one forward is open, type `specialUse` (Android 14+ requires a type; no other type fits a local port relay, and `dataSync` is capped at 6 hours a day on Android 15), with an ongoing notification whose Stop ends every forward. It starts from the menu, while Paseo is in front, as Android 12+ requires. Without the notification permission (Android 13+) the forwards still run and the notification is hidden.
- **JS timers.** React Native pauses JS timers when the app is paused unless a headless JS task runs (`JavaTimerManager`). The daemon client keeps its connection healthy on timers, so the module starts the `PaseoPortForwardKeepAlive` task with the service and JS finishes it when the last forward stops. The host runtime does not close sockets on background (`setAppVisible`); the OS was the only thing stopping them.
- **Lifetime.** The same as desktop server tabs: forwards stop when the tab closes or suspends, from the menu, or from the notification. The Browser proxy for in-app Android Browser tabs still stops on background (see [Android lifecycle](#android-lifecycle)); forwards are a separate path and do not.
- **Google Play.** A `specialUse` service needs a declaration in the Play Console; the manifest's `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` carries the reason.

### Public URLs

Where nothing can forward (iOS, the web build, any device) a server tab's toolbar has Open in browser, which opens the page at a URL the host itself serves (`port-forward/public-page-url.ts`), in this order:

1. A page off loopback opens at its own URL.
2. With a [browser preview template](#configuration) on the host (`server_info.browserPreview.urlTemplate`), any loopback port opens at its preview hostname, with the path and query kept. The daemon forges `Host` to `localhost:<port>`, so dev-server host checks pass, and WebSocket upgrades are proxied, so HMR that connects to the page's own origin (Vite's default) works.
3. Otherwise, when the port belongs to a running `paseo.json` service with a public alias (`serviceProxy.publicBaseUrl`), it opens at that alias. Only service ports have one, and the service sees the public `Host`.
4. Otherwise the button says which port has no public URL and names both settings.

On Android the forward menu offers the public URL as its last row, for a page another device should open too.

What a public URL cannot do: a page that calls another port by an absolute `localhost:<port>` address (an API on `:8080`, HMR on its own port) reaches that port on the device, not the host, because the public origin covers one port. Same-origin calls, relative URLs and a dev-server proxy work. Cookies and OAuth redirects pinned to `localhost` also break. Forwarding is the route that keeps all of these. Public URLs skip daemon authentication (see the warning under [Configuration](#configuration) and [Service Proxy](service-proxy.md)), and the menu says so.

iOS does not get forwarding. iOS suspends an app shortly after it leaves the screen and has no foreground-service equivalent: background modes cover audio, location, VoIP and similar, not a socket server, so the WebSocket every forward rides stops when the user's browser comes to the front. The web build cannot bind ports at all.

## Workspace services in the Browser

`paseo.json` services are part of the Browser, not a separate origin:

- The Browser toolbar lists the workspace's services on Electron, Android and the web build (`services-menu.tsx`, mounted by each pane). A running one opens at `http://localhost:<port>/`; a stopped one starts and opens once the daemon reports it running. The URL bar shows the service name when the tab's port belongs to a running service.
- The service paseo.json marks `"preview": true` (see [Main preview](../public-docs/worktrees.md#main-preview)) leads that menu as Open preview, and gets an Open preview half on the header scripts button and an Open preview row in the compact header menu. Those two open it through the scripts menu's route choice, so the Browser gets the localhost route and an external open keeps the selected one.
- Listing services, finding the main preview and start-then-open live in `packages/app/src/workspace-services/`, with no UI, so any other viewer reuses them instead of copying the menu.
- Opening a service in the Browser from the scripts menu or the ports panel uses the same `http://localhost:<port>/` route (`resolveServiceBrowserUrl` in `packages/app/src/utils/workspace-script-links.ts`). External opens keep the selected route, and a selected public URL stays public in the Browser too.

So a service, a hand-typed `localhost:<port>` tab and an agent's `browser_new_tab` share one origin and one cookie jar. The generated `*.localhost` service hostname is still what external browsers and public aliases use.

## Web build

A web build Browser tab has no engine hook to install a proxy into — an `<iframe>` can only load URLs the user's own browser can reach, so `http://localhost:3000` typed into a web build resolves against the _user's_ machine, not the daemon's. Electron and Android solve this client-side, inside the browser engine; the web build cannot, so the daemon solves it instead by serving an origin per loopback port and reverse-proxying it.

```
browser ──HTTP/WS──> 3000--daemon-1.studio.example.com
                       └─> daemon (Host-matched) ──> 127.0.0.1:3000
                                                     Host: localhost:3000
```

An inbound `Host` header matching a configured hostname template is forwarded to `127.0.0.1:<port>` on the daemon's own machine, with `Host` forged back to `localhost:<port>` so the dev server sees an ordinary loopback request — Vite host checks, cookie domains, and CORS behave as they do locally. WebSocket upgrades are proxied the same way, so HMR needs no special handling. There is no Service Worker; the daemon does the proxying, and the app's own part is resolving each tab's URL before it ever reaches the iframe.

That resolution is what decides preview versus direct: a loopback host and port substitute `{port}` into the template already received on `server_info`; everything else loads directly in the iframe. A direct `src` is the tab's raw, unvalidated URL, so `web-preview-url.ts` allowlists `http:`/`https:` before it reaches the iframe — `normalizeBrowserUrl` otherwise passes any `scheme:`-prefixed string through unchanged, so without this check a `javascript:` or `data:` URL on a tab record would execute in the app's own origin. The preview path skips the check: that URL is built from the host's own `browserPreview.urlTemplate`, a trusted config value, not arbitrary input. Electron and Android already gate navigation to unsupported schemes before a page loads; the web iframe has no equivalent and cannot gain a reactive one. A cross-origin `<iframe>` emits no navigation events its parent could inspect, and the injected bridge below closes that gap only for pages the daemon itself serves — a direct URL reports nothing.

### Injected bridge

Proxied `text/html` responses are rewritten on the way through. The daemon splices three inline scripts — navigation, eruda, element selector — into the document, and the web Browser pane drives them over `postMessage`. That is where the web build's URL bar, back/forward, devtools and click-to-select element attachments come from; a cross-origin `<iframe>` gives its parent none of that on its own.

The scripts go after the opening `<head>`, not before `</body>`. The navigation script patches `history.pushState`, and a patch installed after the page's own JavaScript misses every route change during hydration, so the address bar is already wrong by the first frame the parent can observe.

Only the head is buffered — up to `</head>`, then every later byte passes through untouched, so a streaming-SSR page keeps streaming instead of collapsing into one late flush. Buffering stops at 64 KiB, and the search window is clamped to that same 64 KiB rather than only the buffer: searching everything received so far and checking the cap afterwards would make identical bytes inject or not depending on how upstream happened to chunk them.

Two things are undone so the splice lands. `gzip`, `deflate` and `br` bodies are decompressed first, since splicing tags into compressed bytes yields a document no browser can read; an encoding the daemon cannot decode disables injection instead of corrupting the response. And `<meta http-equiv="content-security-policy">` is stripped from the head window — the proxy drops the CSP response header already, but a meta tag survives that and would block the injected scripts.

The bridge is not advertised on `server_info`. The navigation script posts a `ready` message once it installs, and the pane keys off that, so `packages/protocol` needs no change for any of this: a host serving no proxied HTML never sends the message, and the pane stays on its no-bridge path.

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

- **Classification rides Express mount order, not a branch in `classifyHost`.** `browserPreview.middleware()` is mounted ahead of `serviceProxy.middleware()` (`bootstrap.ts:677` and `:682`). A matched request never calls `next()`, so it never reaches `classifyHost`'s `known-service-miss` branches, which would otherwise 404 a preview host that happens to fall under a configured public base. This feature's own commits touch `service-proxy.ts` only to export two existing helpers; an unrelated earlier commit accounts for the rest of the file's history against `main`, so `git blame` — not a raw diff — is what confirms that.
- **The forwarding policy is owned, not shared.** Service routes pass `Host` and `X-Forwarded-*` through; preview inverts both, forging `Host` to `localhost:<port>` and dropping `X-Forwarded-*` so the dev server sees what looks like a direct loopback hit. Threading a policy parameter through `proxyHttpRequest`, `proxyUpgradeRequest`, and `buildForwardedHeaders` to share that code would be the more invasive change, so `packages/server/src/server/browser-preview/` owns its own forwarding instead.
- **Preview hosts bypass the host allowlist by construction, exactly as service routes do.** The allowlist middleware (`bootstrap.ts:687`) only runs when a request reaches it via `next()`, and a handled preview request never does. No `hostnames`/`allowedHosts` entry is needed for the preview hostname pattern.

A fourth constraint surfaced once WebSocket upgrades were wired up. `ws`'s `{ server, path: "/ws" }` attachment installs its own `upgrade` listener that synchronously aborts any request whose path isn't `/ws` — including one another listener already started an async claim on, destroying the socket out from under it before a preview dial could complete, which made HMR impossible. `createWebSocketServer` now attaches with `noServer: true` and exposes `handleUpgrade()` (`websocket-server.ts:813`); `bootstrap.ts` offers each socket to preview, then `/ws`, then the service proxy in one explicit router (`bootstrap.ts:840`), so no listener can abort a claim another intends to make. This incidentally fixed the same race for registered `paseo.json` service WebSocket routes, which predate preview and shared the same failure mode.

Only `normalizeHostHeader` and `stripHopByHopHeaders` are imported from `service-proxy.ts`, one `export` keyword each: host parsing has to agree with `classifyHost`'s own parsing, and hop-by-hop headers are an HTTP fact that would rot if copied. Everything else — the proxy, the template parser, the response rewriter — is fork-owned in `packages/server/src/server/browser-preview/`.

### Known limitations

- **A direct URL gets no bridge at all.** Injection only touches the daemon's own proxied responses, so a tab on any other origin has no URL sync, no devtools and no element picker, and its back/forward walks the parent's record of URL-bar moves. In-page navigation there stays invisible. The page still loads, under a sticky notice.
- **Devtools need internet from the client.** eruda is fetched from jsdelivr by the previewed page rather than bundled into the server package. A client that cannot reach the CDN gets no devtools and no explanation: the toolbar button un-toggles and stops there.
- **A `Content-Security-Policy` added after the daemon disables the whole bridge.** The proxy strips CSP from the dev server's response and from meta tags in the head window, but it cannot strip one a reverse proxy adds on the way out. That blocks the injected inline scripts, so the tab degrades to the same no-bridge toolbar as a direct URL, with no notice to say so — the notice is keyed on the URL being unproxied, and this one is proxied.
- **A `<head>` still open after 64 KiB streams unmodified**, degrading the same silent way. The cap only bites once that many bytes actually arrive: a shorter document that ends without ever closing its head is still injected. Clamping there keeps output independent of upstream chunking, and a head that large is not worth delaying the response for.
- **On the web build, a service opened through its generated hostname and the same port opened as a preview are two origins.** The service hostname and the preview hostname have separate cookie jars, so signing in on one does not carry over. Electron and Android do not have this split: they open services at the localhost route ([Workspace services in the Browser](#workspace-services-in-the-browser)). The web build keeps both because a public service URL works without a preview template.

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
- Do not spawn `daemon status` or any other CLI from `register-workspace-browser`. That IPC sits on the new-tab path before attach; a slow child process races the 5s automation wait and can `closeAllConnections` after the guest has already started. Direct-loopback reads the last successful desktop daemon status probe, or a renderer flag when the host connection is this machine.
- When that tab is local, do not install the loopback proxy. `<-loopback>` forces 127.0.0.1 through the workspace tunnel; on the desktop daemon that loads a blank guest instead of the local page. Remote hosts still get the proxy.
- Do not route Browser localhost through generated service-proxy hostnames. That would change the visible origin and break pages that expect `localhost`.
- Normal HTTP proxy requests force `Connection: close` after the rewritten request. This makes Chromium open a fresh proxy connection for later Vite module requests, so every request is parsed and rewritten from proxy absolute-form to origin-form. WebSocket upgrade requests keep their upgrade connection for HMR.

## Browser profile compatibility

Browser webviews use workspace-scoped partitions (`persist:paseo-browser-workspace-${workspaceId}`). This scopes loopback proxying and localhost cookies to the workspace:

- Tabs within the same workspace share the same workspace session, sharing localhost cookies (both direct loopback and localhost service proxy URLs) and the workspace's loopback proxy.
- Different workspaces remain isolated, preventing localhost cookies or proxy settings from leaking between workspaces.
- Non-localhost cookies (including external web sites and non-localhost service URLs that proxy to the daemon) are synchronized across all workspace sessions and the shared profile session (`persist:paseo-browser`).

Upstream's attached-webview identity checks and profile cleanup still apply to these prefixed partitions.

## Testing

Use focused tests for the protocol codec and daemon forwarder:

```bash
npx vitest run packages/protocol/src/binary-frames/tcp-tunnel.test.ts packages/protocol/src/binary-frames/demux.test.ts --bail=1
npx vitest run packages/server/src/server/tcp-tunnel-forwarder.test.ts --bail=1
```

For full Electron behavior, use a real Browser pane or browser automation tab because the important behavior depends on Electron session proxying and webview partitions.

Failure handling, link routing, services and port forwarding have focused coverage:

```bash
npx vitest run packages/desktop/src/features/browser-loopback-proxy.test.ts packages/desktop/src/features/browser-loopback-direct.test.ts packages/desktop/src/features/browser-port-forward.test.ts packages/desktop/src/features/browser-loopback-traffic.test.ts --bail=1
npm test --workspace=@getpaseo/app -- src/desktop/browser/pane/load-failure.test.ts src/desktop/browser/pane/port-forward-menu.test.ts src/utils/workspace-url-open-action.test.ts src/utils/workspace-script-links.test.ts --bail=1
npm test --workspace=@getpaseo/app -- --project browser src/desktop/browser/resident-webviews.browser.test.ts --bail=1
```

Android request parsing has Kotlin unit coverage in the local Expo module. `.github/workflows/ci.yml` runs those tests and a one-worker debug assembly only when Android Browser paths change. Do not use local Expo prebuild, Gradle, emulator, Maestro, APK, or AAB builds as routine verification for this feature; use focused JS tests plus formatting, lint, and typecheck locally, and leave native compilation and device validation to GitHub Actions or the cloud release workflow.

Web build routing has unit coverage in the fork-owned proxy module and the app-side URL resolver:

```bash
npx vitest run packages/server/src/server/browser-preview/index.test.ts packages/server/src/server/browser-preview/url-template.test.ts packages/server/src/server/browser-preview/response-headers.test.ts packages/server/src/server/browser-preview/bootstrap-mount.test.ts packages/server/src/server/config-browser-preview.test.ts --bail=1
npx vitest run packages/app/src/desktop/browser/pane/web-preview-url.test.ts packages/app/src/desktop/browser/workspace-browser-availability.test.ts packages/app/src/desktop/browser/workspace-browser-preview.test.ts --bail=1
```

The injected bridge splits the same way — the rewriter and the three scripts on the daemon side, the message plumbing and the navigation reducer on the app side:

```bash
npx vitest run packages/server/src/server/browser-preview/html-injection.test.ts packages/server/src/server/browser-preview/inject --bail=1
npx vitest run packages/app/src/desktop/browser/pane/web-bridge.test.ts packages/app/src/desktop/browser/pane/web-navigation.test.ts packages/app/src/desktop/browser/pane/web-submit.test.ts --bail=1
```

eruda actually loading from jsdelivr and rendering has no unit coverage — it needs a real network and a real browser. Verify it by hand against a running preview, per [docs/qa.md](qa.md).
