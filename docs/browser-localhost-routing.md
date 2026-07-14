# Browser Localhost Routing

The in-app Browser on Electron desktop has per-browser localhost routing. When a Browser tab belongs to a workspace on host `H`, loopback URLs loaded inside that Browser are resolved against host `H`, not against the machine running the desktop frontend.

This is separate from the service proxy. The service proxy exposes `paseo.json` service scripts through generated hostnames and optional public URLs. Browser localhost routing is for raw loopback URLs that a user or page enters directly, such as `http://localhost:5173`, `http://127.0.0.1:3000`, or a WebSocket opened to `ws://localhost:3000`.

## Routing scope

- Applies only to Electron desktop Browser panes and browser automation tabs.
- Applies per Browser instance. Each Browser uses its own Electron session partition, so multiple Browser panes can point `localhost:3000` at different workspace hosts at the same time.
- Applies to loopback hosts: `localhost`, `*.localhost`, `127.*`, `::1`, `::`, and `0.0.0.0`. Explicit IPv6 loopback URLs are tunneled to `::1` on the host daemon; all other loopback forms use `127.0.0.1`.
- Preserves the visible URL and page origin. The user still sees `localhost:<port>` in the Browser, and page code still observes the same origin it requested.
- Does not affect the system browser, the web app running in a normal browser, or service proxy generated URLs.
- Assistant chat and terminal links keep rendering the original `localhost` URL. On Electron desktop, clicking one opens that original URL in the workspace Browser so this routing layer can handle it.
- Code Server tabs on Electron desktop reuse the Browser webview and this same localhost routing layer, but hide Browser chrome so the tab feels like an embedded editor.

## How it works

1. The renderer registers each Browser with Electron main using `{ browserId, serverId, workspaceId }`.
2. Electron main creates a loopback HTTP proxy for that Browser and applies it to the Browser's `persist:paseo-browser-${browserId}` session partition with loopback proxy bypass disabled. The proxy requires per-Browser Basic proxy auth; Electron main only supplies those credentials for the matching Browser webContents.
3. For non-loopback requests, the proxy connects directly to the requested host.
4. For loopback requests, the proxy asks the renderer to open a TCP tunnel on the Browser's registered `serverId`.
5. The renderer uses that host's existing daemon WebSocket client to open a binary TCP tunnel to the daemon.
6. The daemon connects to `127.0.0.1:<port>` or `::1:<port>` on its own machine and relays bytes over the WebSocket tunnel.

The tunnel protocol is a binary WebSocket frame family in `packages/protocol/src/binary-frames/tcp-tunnel.ts`. The daemon advertises support through `server_info.features.tcpTunnel`; old daemons do not get a fallback path. The UI-side tunnel controller checks this capability in one place and reports that the host must be updated.

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

## Testing

Use focused tests for the protocol codec and daemon forwarder:

```bash
npx vitest run packages/protocol/src/binary-frames/tcp-tunnel.test.ts packages/protocol/src/binary-frames/demux.test.ts --bail=1
npx vitest run packages/server/src/server/tcp-tunnel-forwarder.test.ts --bail=1
```

For full Electron behavior, use a real Browser pane or browser automation tab because the important behavior depends on Electron session proxying and webview partitions.
