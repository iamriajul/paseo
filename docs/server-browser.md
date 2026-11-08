# Server browser

The server browser is a browser the daemon drives on its own host. Agents drive it through the usual MCP browser tools, and every client (desktop, web, phone) watches the same tab live and can take it over. It keeps working with every app closed, and `localhost` in it is the daemon host's localhost, so workspace dev servers open without a tunnel.

It is experimental and off by default.

## Turn it on

Settings → the host → Agents → Browser tools card → **Server-side browser (experimental)**, then pick an engine. Any engine also turns on Browser tools: the server browser only serves agents through them. The choice is a host setting (`serverBrowser.enabled` and `serverBrowser.engine` in that host's `config.json`), because the daemon decides where tabs open. A host turned on before engines existed keeps Headless (light).

| Engine           | `engine`         | What runs                                                                              | Workspaces                             | Logins persist                                                                    |
| ---------------- | ---------------- | -------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------- |
| Headless (light) | `headless`       | Playwright's headless shell, started by the daemon                                     | a browser context each, nothing shared | cookies and localStorage, saved by the daemon                                     |
| Managed Chrome   | `managed-chrome` | real Google Chrome, started by the daemon, in a window (Window) or headless (Headless) | share one profile and cookie jar       | everything, in Chrome's own profile                                               |
| Existing browser | `existing`       | a Chrome already running on the host (`serverBrowser.cdpUrl`, default port 9222)       | share that browser's cookie jar        | whatever that browser keeps; the daemon never closes it or touches its other tabs |

Pick Managed Chrome when a site has to treat the browser as a person's (Google sign-in, captchas), Existing browser to reuse a Chrome you already signed into, and Headless (light) for the least memory and workspaces kept apart. Engines live in `packages/server/src/server/server-browser/engines.ts`; adding one is a kind, its traits and a start function there.

Headless (light) needs a Chromium. The daemon looks, in order, at:

1. `serverBrowser.executablePath` in `config.json`, or `PASEO_SERVER_BROWSER_EXECUTABLE`;
2. Playwright's browser cache (`~/.cache/ms-playwright`, or `PLAYWRIGHT_BROWSERS_PATH`): the newest `chromium_headless_shell-*`, then the newest `chromium-*`;
3. `chromium`, `chromium-browser`, `google-chrome` or `google-chrome-stable` on `PATH`.

If none is found, the tool call and the Settings row say so. Install one as the user the daemon runs as:

```bash
npx playwright install chromium-headless-shell
```

Managed Chrome needs Google Chrome: `PASEO_SERVER_BROWSER_CHROME`, else `google-chrome`, `google-chrome-stable`, `chromium` or `chromium-browser` on `PATH`. Existing browser needs a Chrome started with `--remote-debugging-port`.

Headless (light) and Managed Chrome always start their own process with their own profile under `$PASEO_HOME/server-browser`, so a Chrome you run yourself (for example one on port 9222) is never touched unless you pick Existing browser.

## What it does

- **Routing.** While the server browser is on, every `browser_new_tab` opens in the server browser, even while an app with its own Browser is connected. Commands on a server tab go to the server browser; a tab an app opened before the switch stays with that app. `browser_list_tabs` lists both. With it off, nothing changes and no browser starts. See `packages/server/src/server/server-browser/router.ts`.
- **Commands.** The server browser runs the same automation engine as the desktop app's Browser, vendored from `packages/desktop/src/features/browser-automation` (the server cannot import desktop). Snapshots, `@eN` refs, actionability waits and errors are identical on both hosts. After an upstream change to the desktop engine, run `node scripts/sync-server-browser-engine.mjs`; `engine-sync.test.ts` fails until you do.
- **Viewing.** An agent's tab opens in its workspace in the background on every client, as a tab with a server icon. A tab the daemon closes leaves the workspace. The toolbar has back, forward, reload, the URL, a Desktop (1280×800) or Phone (390×844) viewport, and a menu with **Clear browser data** and **Close tab**.
- **Taking over.** On desktop and web, mouse, wheel, keyboard and paste go to the page. On a phone, a tap clicks, a drag scrolls, a long press right-clicks, and the keyboard button opens a "Type into the page" bar.
- **Opening a service.** While the server browser is on, every URL the workspace would open in its Browser (the scripts menu's Open, the ports panel, localhost links in chat) opens in a server tab instead.

## How it works

```
agent ──MCP──> daemon ──ServerBrowserRoutingBroker──> ServerBrowserHost
                                                        │ one browser per host, from the engine
                                                        │ CDP over --remote-debugging-pipe, or a WebSocket (Existing browser)
client <──WebSocket: browser.server.* RPCs, binary 0x40 frames / 0x41 acks──┘
```

- **One browser per host.** Every engine yields the same CDP browser (`shared-chromium.ts`), so tabs, the viewer and the MCP tools never see which one runs. The host's first tab starts it or connects to it.
- **Headless (light): one browser context per workspace.** each workspace's first tab opens a CDP browser context in it (`Target.createBrowserContext`). Contexts never share cookies, storage or renderer processes; they share the browser, GPU, network and zygote processes, so a second workspace costs only its pages. v0.15.904 ran one Chromium per workspace with a persistent profile, which kept IndexedDB with no code of ours but paid a whole browser process tree per workspace; that tree is the cost this design removes. See `shared-chromium.ts`.
- **Headless (light) storage is saved by the daemon.** Contexts live in memory, so the daemon writes each workspace's cookies (session cookies included) and localStorage to `$PASEO_HOME/server-browser/storage/<workspaceId>.json`, in a directory only its user can read, and loads them into the workspace's next context. It saves 2 s after a tab navigates, every 30 s while the workspace has tabs (a login by `fetch` sets a cookie without navigating), when the context closes, and on shutdown; an unchanged state is not rewritten. localStorage of an origin no tab has open is read and restored from a hidden page whose every request is answered with an empty document, so the origin's server need not run and its scripts never execute (Playwright's storageState does the same). IndexedDB, sessionStorage, Cache Storage and service workers are not saved: a login kept only in IndexedDB (Firebase Auth's default) does not survive the context closing. Cookie logins (better-auth, Auth.js/NextAuth, Lucia, express-session) and localStorage tokens (Supabase) do. See `workspace-storage-state.ts`.
- **Clear browser data** (Headless (light) only) disposes the workspace's context without saving, deletes its storage file, and reopens its tabs in a new context at their URLs under the same ids. Other workspaces are untouched. The real-Chrome engines share one profile, so the menu hides it there (`status.engine.sharedStorage`).
- **Managed Chrome** is set up the way people run a Chrome for CDP by hand: real Chrome, a persistent profile with first run and metrics pre-answered, no automation switches. It has two modes, picked under Managed Chrome in Settings (`serverBrowser.chromeMode`).
- **Managed Chrome modes are separate Chromes with separate profiles**: `$PASEO_HOME/server-browser/chrome-profile-window` and `chrome-profile-headless`. Logins do not carry across, so you sign in to each; a session a site flagged as headless never reaches the windowed profile. Switching mode closes one Chrome and starts the other. The single `chrome-profile` of the first engines build becomes the Window profile on first start.
- **Window** (the default) runs headed on the first live X display (`DISPLAY`, then `/tmp/.X11-unix`), else on an Xvfb it starts and stops with Chrome, else `--headless=new`. The daemon launches that Xvfb through util-linux `setpriv --pdeathsig KILL`, so a killed daemon takes it down too; a host without `setpriv` stops it only on a graceful exit. On a host with a desktop (a VNC session, for example) its windows show on that desktop, where you can also use them; `PASEO_SERVER_BROWSER_DISPLAY=xvfb` keeps them on a private Xvfb, and `PASEO_SERVER_BROWSER_DISPLAY=:N` picks a display.
- **Headless** runs the same Chrome and flags with `--headless=new` and no display, and less memory (see Cost). New headless puts `HeadlessChrome` in its UA by design, so the daemon passes `--user-agent` with what this Chrome reports in a window: Chrome's reduced UA, built from the major version `--version` prints and the OS. That is the only thing it changes; `navigator.userAgentData` brands and the `Sec-CH-UA` header already match the windowed Chrome.
- **Both modes** skip Playwright's automation switches and add `--disable-blink-features=AutomationControlled`: on Chrome 153, `navigator.webdriver` is true for any CDP client, pipe or port, until that is off. Within a mode, one profile serves every workspace: a profile per workspace would mean a Chrome per workspace and a Google sign-in per workspace, and a context per workspace would lose IndexedDB and Google's own session state. Chrome keeps everything itself except session cookies (no expiry), which end with a browser session; the daemon carries those across its own restarts of Chrome, per mode (`$PASEO_HOME/server-browser/chrome-session`), saved every 30 s while tabs are open, before the last tab closes, and when Chrome closes.
- **Headed tabs each get a background window**, because Chrome stops painting a tab behind another in the same window, and the screencast would freeze. A headed Chrome keeps its startup window until the first tab exists: one with no window quits on the next profile write.
- **Existing browser** connects to `serverBrowser.cdpUrl` (`/json/version` gives the WebSocket). It opens Paseo's tabs in that browser's default context, so they share its logins, as background windows, so the owner's window keeps focus. The daemon acts only on targets it created, by id: it never closes, restarts or idle-exits that browser, never touches its other tabs, and on shutdown closes only its own tabs. It refuses downloads per page, because the browser-wide setting is the owner's. Other tools driving that browser (for example `agent-browser`, which acts on the active tab) can still reach Paseo's tabs.
- **CDP over a pipe** for the engines the daemon starts, not a TCP port: nothing else on the host can attach, and the browser exits when the daemon's end of the pipe closes, so a killed daemon leaves no orphan browser.
- **Sandbox.** Chromium starts sandboxed. If the kernel offers no usable sandbox (containers, this kind of Kubernetes pod), the daemon relaunches it with `--no-sandbox` and logs a warning once. Playwright does the same by default.
- **Screencast.** One CDP `Page.startScreencast` per tab, running only while someone watches, at the largest size any viewer asked for (capped at 1600 px), JPEG quality 60. Chromium emits frames only when the page paints, so an idle page costs nearly nothing.
- **Flow control.** Each viewer has a window of unacked frames: 2 on a fast link, more on a long one, sized from its minimum ack round trip to allow about 15 fps (at most 8). A viewer out of window keeps only the newest frame; old frames are dropped, never queued. Chromium's own ack is released as soon as any viewer has room, so a slow phone never slows a fast desktop. See `screencast-hub.ts`.
- **Input.** Pointer coordinates travel as fractions of the frame, so clients never need the page's CSS size. Each input request takes one slot in the tab's CDP queue, so a release sent in its own request can never overtake the press before it.
- **Dialogs.** `alert`, `confirm` and `prompt` are accepted automatically and recorded in the tab's console log: a headless tab with an open dialog would block every later command.

Protocol: gate on `server_info.features.serverBrowser`, and the engine choice on `server_info.features.serverBrowserEngines` (older hosts get the on/off switch). RPCs and frames are in `packages/protocol/src/server-browser/rpc-schemas.ts` and `packages/protocol/src/binary-frames/server-browser.ts`. Every RPC needs `workspace.write` except the tab list (`workspace.read`): a frame shows the agent's signed-in pages, and input controls them.

## Limits

| Limit                               | Value                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Open tabs per host                  | 8 across all workspaces; `browser_new_tab` past it fails and tells the agent to close tabs               |
| Workspace with no tabs              | its storage is saved and its context closed after 3 minutes                                              |
| Host with no workspace context open | after 2 more minutes, a browser the daemon started exits; an Existing browser is only disconnected       |
| Tab no agent or viewer touched      | closed after 30 minutes (a heavy page holds 150–200 MB until then)                                       |
| URLs                                | `http` and `https` only, from agents and users; downloads are refused in every context                   |
| Daemon shutdown                     | storage saved (5 s budget), `Browser.close`, then SIGKILL after 3 s                                      |
| Browser crash or restart            | every tab on the host closes; storage is what the last save wrote; the next tab relaunches or reconnects |

## Cost

Measured on the dev box (16 cores) with Playwright's headless shell 1208:

|                                                   | Direct (same host)                                                      | Through relay.paseo.sh (430 ms RTT from the box) |
| ------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------ |
| Click until the changed pixel arrives (p50 / p95) | 19 / 27–41 ms                                                           | 450 / 452 ms                                     |
| Page animating every frame                        | 60 fps, 3.1 Mbit/s                                                      | 15.9 fps, 0.84 Mbit/s                            |
| Static page                                       | about 0 (frames only on paint); a blinking caret costs about 0.5 Mbit/s |                                                  |

- **Memory:** PSS of Chromium's whole process tree (browser, GPU, network, zygotes, renderers), from `/proc/<pid>/smaps_rollup`, with every tab on the Paseo web app's production build served locally (a heavy SPA, about 175 MB per renderer). Median of three samples 12 s after load; two alternating rounds agreed within 4%.

  | Tabs                  | One Chromium per workspace (v0.15.904) | Shared Chromium, contexts, flags |
  | --------------------- | -------------------------------------- | -------------------------------- |
  | 1 workspace × 1 tab   | 382 MB (RSS 603)                       | 275 MB (RSS 493)                 |
  | 3 workspaces × 1 tab  | 845 MB (RSS 1814)                      | 532 MB (RSS 941)                 |
  | 3 workspaces × 3 tabs | 1975 MB (RSS 3520)                     | 950 MB (RSS 1387)                |

  RSS counts shared pages once per process, so it overstates the per-workspace design; compare PSS. The shared browser saves about 100 MB PSS per extra workspace. The flags in `cdp-connection.ts` save the rest, each measured alone on 3 workspaces × 3 tabs against 1896 MB: `--process-per-site` 628 MB (same-site tabs of one workspace share a renderer), `--js-flags=--optimize-for-size` 535 MB, `--disable-gpu` 84 MB (software compositing, no GPU process). Measured and left out: `--enable-low-end-device-mode` (saves the same as `--optimize-for-size` and changes more than V8), `--max-semi-space-size=2` (nothing on top of the others), `--in-process-gpu` (moves the GPU memory into the browser process), disabling the back/forward cache (headless already keeps one renderer per tab across navigations), and `--no-zygote` (Chromium refuses it unless the sandbox is off, which the daemon only does as a fallback).

- **Engines:** the same pages and method, with `SwapPss` added because the box was swapping, ranges over two rounds. Managed Chrome includes the Xvfb it started (40–70 MB).

  | Tabs                  | Headless (light) | Managed Chrome |
  | --------------------- | ---------------- | -------------- |
  | 1 workspace × 1 tab   | 271–272 MB       | 534–606 MB     |
  | 3 workspaces × 1 tab  | 490–531 MB       | 639–713 MB     |
  | 3 workspaces × 3 tabs | 887–899 MB       | 1103–1145 MB   |

  Managed Chrome costs about 300 MB more to start (a full browser process, a GPU process for WebGL, the display), then less per workspace, because workspaces share its renderers. Existing browser adds only Paseo's tabs to a browser that runs anyway.

  Managed Chrome's two modes, the same method:

  | Tabs                  | Window (with its Xvfb) | Headless     |
  | --------------------- | ---------------------- | ------------ |
  | 1 workspace × 1 tab   | 534–535 MB             | 460–469 MB   |
  | 3 workspaces × 1 tab  | 683–689 MB             | 607–616 MB   |
  | 3 workspaces × 3 tabs | 1098–1102 MB           | 1027–1063 MB |

  Headless saves 40–75 MB: no Xvfb and a smaller browser process. New headless still runs a GPU process (about 70 MB), so it stays well above Headless (light).

- **Start:** about 0.4–1.1 s for the host's first tab (Chromium starts); a new workspace's first tab while Chromium runs opens in about 35 ms, or about 75 ms when it restores saved cookies and one origin's localStorage; later tabs open in 30–130 ms.
- **CPU:** JPEG encoding runs in Chromium and only while a viewer watches. A relayed viewer adds per-frame encryption on the daemon's event loop. The window keeps that to about 15 fps.

## Known gaps

- Electron runs the same web viewer as the browser build (`surface.web.tsx`), and the browser build is what was verified. The desktop app itself has not been run against it.
- A phone viewer has no pinch zoom. Use the Phone viewport for mobile layouts.
- A tab's own popups (`window.open`) open as separate Chromium targets that the server browser does not show.
- New strings are English only.
- Same-site tabs of one workspace share a renderer process (`--process-per-site`), so a tab running a long script stalls its same-site siblings, and a renderer crash closes them together.
- With `--disable-gpu` the first screencast frame after a viewer attaches can be blank; the next paint replaces it.
- One browser serves every workspace, so a browser crash closes every workspace's tabs.
- In Managed Chrome and Existing browser, workspaces share one cookie jar: two dev servers on `localhost` with the same cookie name overwrite each other's sessions.
