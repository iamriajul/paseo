# Browser Localhost Routing

The in-app Browser on Electron desktop and Android has workspace-aware localhost routing. When a Browser tab belongs to a workspace on host `H`, loopback URLs loaded inside that Browser are resolved against host `H`, not against the machine running the client.

This is separate from the service proxy. The service proxy exposes `paseo.json` service scripts through generated hostnames and optional public URLs. Browser localhost routing is for raw loopback URLs that a user or page enters directly, such as `http://localhost:5173`, `http://127.0.0.1:3000`, or a WebSocket opened to `ws://localhost:3000`.

## Routing scope

- Applies to Electron Browser panes and browser automation tabs, plus human-operated Android Browser panes. Browser automation and DevTools remain Electron-only.
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
