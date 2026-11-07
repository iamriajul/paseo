# Server browser

The server browser is a headless Chromium the daemon runs on its own host. Agents drive it through the usual MCP browser tools, and every client (desktop, web, phone) watches the same tab live and can take it over. It keeps working with every app closed, and `localhost` in it is the daemon host's localhost, so workspace dev servers open without a tunnel.

It is experimental and off by default.

## Turn it on

Settings → the host → Agents → Browser tools card → **Server-side browser (experimental)**. Turning it on also turns on Browser tools: the server browser only serves agents through them. The switch is a host setting (`serverBrowser.enabled` in that host's `config.json`), because the daemon decides where tabs open.

The daemon needs a Chromium on its host. It looks, in order, at:

1. `serverBrowser.executablePath` in `config.json`, or `PASEO_SERVER_BROWSER_EXECUTABLE`;
2. Playwright's browser cache (`~/.cache/ms-playwright`, or `PLAYWRIGHT_BROWSERS_PATH`): the newest `chromium_headless_shell-*`, then the newest `chromium-*`;
3. `chromium`, `chromium-browser`, `google-chrome` or `google-chrome-stable` on `PATH`.

If none is found, the tool call and the Settings row say so. Install one as the user the daemon runs as:

```bash
npx playwright install chromium-headless-shell
```

The daemon never attaches to a browser that is already running. It always starts its own process with its own profile, so the Chrome you use on that host (for example one on port 9222) is never touched.

## What it does

- **Routing.** With the switch on, every `browser_new_tab` opens in the server browser, even while an app with its own Browser is connected. Commands on a server tab go to the server browser; a tab an app opened before the switch stays with that app. `browser_list_tabs` lists both. With the switch off, nothing changes and Chromium never starts. See `packages/server/src/server/server-browser/router.ts`.
- **Commands.** The server browser runs the same automation engine as the desktop app's Browser, vendored from `packages/desktop/src/features/browser-automation` (the server cannot import desktop). Snapshots, `@eN` refs, actionability waits and errors are identical on both hosts. After an upstream change to the desktop engine, run `node scripts/sync-server-browser-engine.mjs`; `engine-sync.test.ts` fails until you do.
- **Viewing.** An agent's tab opens in its workspace in the background on every client, as a tab with a server icon. A tab the daemon closes leaves the workspace. The toolbar has back, forward, reload, the URL, a Desktop (1280×800) or Phone (390×844) viewport, and a menu with **Clear browser data** and **Close tab**.
- **Taking over.** On desktop and web, mouse, wheel, keyboard and paste go to the page. On a phone, a tap clicks, a drag scrolls, a long press right-clicks, and the keyboard button opens a "Type into the page" bar.
- **Opening a service.** While the switch is on, every URL the workspace would open in its Browser (the scripts menu's Open, the ports panel, localhost links in chat) opens in a server tab instead.

## How it works

```
agent ──MCP──> daemon ──ServerBrowserRoutingBroker──> ServerBrowserHost
                                                        │ one Chromium per workspace
                                                        │ CDP over --remote-debugging-pipe
client <──WebSocket: browser.server.* RPCs, binary 0x40 frames / 0x41 acks──┘
```

- **One Chromium per workspace**, started on that workspace's first tab, with a persistent profile at `$PASEO_HOME/server-browser/profiles/<workspaceId>`. Cookies, localStorage and IndexedDB survive browser restarts, so a signed-in dev server stays signed in, and workspaces never share storage. **Clear browser data** wipes the profile and reopens the workspace's tabs at their URLs under the same ids.
- **CDP over a pipe**, not a TCP port: nothing else on the host can attach, and Chromium exits when the daemon's end of the pipe closes, so a killed daemon leaves no orphan browser.
- **Sandbox.** Chromium starts sandboxed. If the kernel offers no usable sandbox (containers, this kind of Kubernetes pod), the daemon relaunches it with `--no-sandbox` and logs a warning once. Playwright does the same by default.
- **Screencast.** One CDP `Page.startScreencast` per tab, running only while someone watches, at the largest size any viewer asked for (capped at 1600 px), JPEG quality 60. Chromium emits frames only when the page paints, so an idle page costs nearly nothing.
- **Flow control.** Each viewer has a window of unacked frames: 2 on a fast link, more on a long one, sized from its minimum ack round trip to allow about 15 fps (at most 8). A viewer out of window keeps only the newest frame; old frames are dropped, never queued. Chromium's own ack is released as soon as any viewer has room, so a slow phone never slows a fast desktop. See `screencast-hub.ts`.
- **Input.** Pointer coordinates travel as fractions of the frame, so clients never need the page's CSS size. Each input request takes one slot in the tab's CDP queue, so a release sent in its own request can never overtake the press before it.
- **Dialogs.** `alert`, `confirm` and `prompt` are accepted automatically and recorded in the tab's console log: a headless tab with an open dialog would block every later command.

Protocol: gate on `server_info.features.serverBrowser`. RPCs and frames are in `packages/protocol/src/server-browser/rpc-schemas.ts` and `packages/protocol/src/binary-frames/server-browser.ts`. Every RPC needs `workspace.write` except the tab list (`workspace.read`): a frame shows the agent's signed-in pages, and input controls them.

## Limits

| Limit                          | Value                                                                 |
| ------------------------------ | --------------------------------------------------------------------- |
| Open tabs per host             | 8; `browser_new_tab` past it fails and tells the agent to close tabs  |
| Workspace browser with no tabs | exits after 10 minutes                                                |
| Tab no agent or viewer touched | closed after 2 hours                                                  |
| URLs                           | `http` and `https` only, from agents and users; downloads are refused |
| Daemon shutdown                | `Browser.close`, then SIGKILL after 3 s                               |
| Chromium crash                 | that workspace's tabs close; the next tab relaunches it               |

## Cost

Measured on the dev box (16 cores) with Playwright's headless shell 1208:

|                                                   | Direct (same host)                                                      | Through relay.paseo.sh (430 ms RTT from the box) |
| ------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------ |
| Click until the changed pixel arrives (p50 / p95) | 19 / 27–41 ms                                                           | 450 / 452 ms                                     |
| Page animating every frame                        | 60 fps, 3.1 Mbit/s                                                      | 15.9 fps, 0.84 Mbit/s                            |
| Static page                                       | about 0 (frames only on paint); a blinking caret costs about 0.5 Mbit/s |                                                  |

- **Memory:** about 225 MB per workspace browser with one light tab. Heavy pages add 50–150 MB each.
- **Start:** 0.6–1.1 s for a workspace's first tab; later tabs open in 50–130 ms.
- **CPU:** JPEG encoding runs in Chromium and only while a viewer watches. A relayed viewer adds per-frame encryption on the daemon's event loop. The window keeps that to about 15 fps.

## Known gaps

- Electron runs the same web viewer as the browser build (`surface.web.tsx`), and the browser build is what was verified. The desktop app itself has not been run against it.
- A phone viewer has no pinch zoom. Use the Phone viewport for mobile layouts.
- A tab's own popups (`window.open`) open as separate Chromium targets that the server browser does not show.
- New strings are English only.
