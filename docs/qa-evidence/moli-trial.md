# Trial: Moli as a server-browser engine

Date: 2026-11-08. Box: the 16-core dev pod, 47 GB RAM, Linux 7.0. Branch `spike/moli-engine`, cut from `origin/main` at `04ea2b009`.

Question: can [Moli](https://github.com/lexmount/moli) replace or supplement Chromium as the engine behind the server browser ([docs/server-browser.md](../server-browser.md)) at a much smaller RAM footprint?

## Verdict: not yet. Moli is a candidate for agent-only browsing later

Moli speaks almost every CDP method the server browser uses. Paseo's real `ServerBrowserHost` and its vendored automation engine drive Moli with no engine changes: they open tabs, take snapshots, click and fill by ref, select, scroll, go back, take screenshots and apply viewer input. It uses a third to a half of Chromium's memory. Two problems keep it out of the server browser today, and both show up on Paseo's own web app:

1. **Geometry is stale on React Native Web pages.** On Paseo's app, every `[role=button]` reports a 0×0 rect from `getBoundingClientRect` until something forces a paint. The engine's ARIA snapshot then finds 0 actionable buttons, where Chromium finds 51, so an agent gets no refs to click. One `Page.captureScreenshot` fixes the rects. Moli's layout is on demand ("script mutations do not refresh it", `moli fetch --help`).
2. **It hangs on large scripts.** A page that loads a 55 MB script (Paseo's Expo dev bundle, or a synthetic 55 MB file) never fires `load`. After that, the whole server stops answering, including browser-level `Browser.getVersion`, while using almost no CPU. A 20 MB script loads in 3.5 s. Chromium loads the 55 MB file in 13 s. The 27 MB production bundle of Paseo's app works.

Other gaps: no `mobile: true` emulation, so the Phone viewport fails. The screencast runs at 1 fps unless the server is started with `--screencast-interval-ms`. Canvas ignores CSS Color 4 colours. Storage is lost on any exit other than `Browser.close`, including SIGTERM. All tabs share one process, so one hung page stalls every workspace on that Moli server.

It does not fit as a **replacement**: users watch and take over server tabs, and Paseo's own app and other React Native Web dev servers are the main pages they open. A **supplement for agent-only browsing** (no viewer, no take-over, an agent reading docs or driving a plain HTML dev server) becomes worth building once Moli fixes the stale-geometry and large-script bugs. Moli releases every few days (v1.1.20 to v1.1.22 in one week), so re-run this harness before deciding.

## 1. Install and run

| Item         | Value                                                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version      | 1.1.22 (released 2026-11-06), `moli-x86_64-unknown-linux-gnu.tar.gz` from GitHub releases                                                                              |
| Licence      | `Apache-2.0 OR MIT` (`license-metadata.json`); ships Chromium BSD-3 and Selenium notices                                                                               |
| Size         | 45 MB tarball, 111 MB single binary; links libstdc++, fontconfig, freetype, libpng, zlib, brotli. No sandbox, no helper processes                                      |
| Run          | `moli serve --host 127.0.0.1 --port <p> -P <profileDir> --layout -r`. The default host is loopback. It listens on TCP only: no `--remote-debugging-pipe`               |
| Reports      | `Chrome/156.0.8078.74` with a **Windows** user agent on Linux, `V8 15.2`, CDP 1.3                                                                                      |
| Flags needed | `--layout` (without it there is no layout, so no screenshots and no screencast), `-r` (without it images, fonts and media are not fetched), `--screencast-interval-ms` |

## 2. CDP coverage

Methods and events from `grep` over `packages/server/src/server/server-browser/` (the vendored engine, `server-browser-tab.ts`, `workspace-browser.ts`, `cdp-connection.ts`). I added the methods a shared-Chromium design with per-workspace contexts needs (`Target.createBrowserContext`, `Storage.*`), plus `DOM.getBoxModel`. Each row is exercised by `scripts/moli-trial/cdp-probe.mjs`. The headless shell (1208, Chromium 145) and Google Chrome 153 pass every row.

| Area       | Method / event                                                                                                                                        | Moli        | Note                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| Browser    | `Browser.getVersion`, `setDownloadBehavior`, `close`                                                                                                  | works       | `Browser.close` exits in about 50 ms                                                                          |
| Target     | `setDiscoverTargets`, `getTargets`, `createTarget`, `attachToTarget {flatten}`, `closeTarget`                                                         | works       |                                                                                                               |
| Target     | `targetInfoChanged`, `targetDestroyed` events                                                                                                         | works       |                                                                                                               |
| Contexts   | `Target.createBrowserContext`, `disposeBrowserContext`, `createTarget {browserContextId}`                                                             | works       | Contexts A and B share no cookies or localStorage                                                             |
| Page       | `enable`, `setLifecycleEventsEnabled`, `navigate`, `reload`, `getNavigationHistory`, `navigateToHistoryEntry`                                         | works       |                                                                                                               |
| Page       | `loadEventFired`, `domContentEventFired`, `frameNavigated`, `frameStartedLoading`, `frameStoppedLoading`, `lifecycleEvent`, `navigatedWithinDocument` | works       |                                                                                                               |
| Page       | `javascriptDialogOpening` + `handleJavaScriptDialog`                                                                                                  | works       |                                                                                                               |
| Page       | `captureScreenshot` (png, jpeg), `getLayoutMetrics`                                                                                                   | works       | Needs `--layout`                                                                                              |
| Screencast | `startScreencast`, `screencastFrame`, `screencastFrameAck`, `stopScreencast`                                                                          | **partial** | 1 fps by default; `--screencast-interval-ms` (a server-wide flag) raises it, see section 5                    |
| Runtime    | `enable`, `evaluate` (returnByValue, awaitPromise, userGesture, objectId), `consoleAPICalled`, `exceptionThrown`                                      | works       | The engine's ARIA snapshot script runs unchanged and gives the same output as Chromium on the fixture pages   |
| DOM        | `describeNode` → `backendNodeId`, `setFileInputFiles`, `getDocument`, `querySelector`, `getBoxModel`                                                  | works       | Box model is identical to Chromium on the fixture                                                             |
| Input      | `dispatchMouseEvent` (move, press, release, wheel), `dispatchKeyEvent` (keyDown, rawKeyDown, keyUp), `insertText`                                     | works       | Emoji and non-ASCII text insert correctly                                                                     |
| Emulation  | `setDeviceMetricsOverride` desktop (1280×800, dpr 1)                                                                                                  | works       |                                                                                                               |
| Emulation  | `setDeviceMetricsOverride {mobile: true}` (Paseo's Phone viewport)                                                                                    | **missing** | Error: "does not support mobile=true". With `mobile: false` the viewport applies but `screen` stays 1920×1080 |
| Emulation  | `setTouchEmulationEnabled`                                                                                                                            | works       |                                                                                                               |
| Storage    | `Network.setCookies`, `getCookies`, `clearBrowserCookies`; `Storage.getCookies`, `setCookies {browserContextId}`, `clearDataForOrigin`                | works       |                                                                                                               |

Running Paseo's real host (`scripts/moli-trial/engine-on-moli.mts` bridges Moli's WebSocket to the NUL-framed streams `CdpConnection` expects, through `ServerBrowserHost`'s `launch` option):

| Host operation                                                           | Moli                                  | Headless shell                         |
| ------------------------------------------------------------------------ | ------------------------------------- | -------------------------------------- |
| `openTab` (launch to first tab)                                          | 270–320 ms                            | 4.4 s (first launch on a cold profile) |
| `snapshot`, click a link by ref, fill + click, select, back              | ok                                    | ok                                     |
| `screenshot`, `scroll`, `resize` (agent), viewer input batch             | ok                                    | ok                                     |
| Viewer Phone viewport (`setViewport` mobile)                             | **fails**                             | ok                                     |
| Desktop viewport, workspace isolation, `clearWorkspaceData`, `close_tab` | ok                                    | ok                                     |
| Cookies and localStorage survive a restart                               | only after `Browser.close`; see below | ok                                     |

`scripts/moli-trial/persistence.mjs`, run twice:

| How the browser stops   | Moli                         | Headless shell |
| ----------------------- | ---------------------------- | -------------- |
| `Browser.close`         | cookie and localStorage kept | kept           |
| SIGTERM                 | **both lost**                | kept           |
| SIGKILL 3 s after write | both lost                    | both lost      |

In the host run, the bridge killed Moli as soon as its socket closed. That raced `Browser.close` and lost storage 4 times out of 5.

## 3. Real pages

`scripts/moli-trial/render-compare.mjs` screenshots each page at 1280×800 in every engine and counts pixels that differ from the headless shell by more than 10% (ImageMagick `compare -fuzz 10%`). Screenshots are in the git-ignored `.dev/moli-trial/` of this worktree. They are not committed.

| Page                                  | Moli vs shell | Chrome vs shell | What differs in Moli                                                                                                                                                                                                    |
| ------------------------------------- | ------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixture: flex, grid, SVG, table, form | 3.34%         | 0.08%           | Form controls: the placeholder is drawn as dark text (it reads like a typed value), the checkbox is black, borders are inset. Monospace text is larger. (`shots/layout-form.png`)                                       |
| Next.js 16 home (`create-next-app`)   | 1.38%         | 1.36%           | The Vercel triangle (`<img src=vercel.svg>` with `filter: invert()`) renders as an empty square (`shots/home-btn.png`). Fonts and layout match                                                                          |
| Next.js `/about`, `/login`            | 0.57%, 0.98%  | 0%, 0%          | Antialiasing only                                                                                                                                                                                                       |
| Next.js `/canvas` (rAF canvas)        | 1.70%         | 0.47%           | **The canvas is blank.** `ctx.fillStyle = 'hsl(270 80% 55%)'` (CSS Color 4 syntax) is ignored and keeps the previous colour. Chromium returns `#8c30e8`. The comma syntax works                                         |
| Paseo web, Expo dev bundle (55 MB)    | no screenshot | 0%              | **Hangs**: no `load` event in 30 s; `Runtime.evaluate`, `captureScreenshot` and `Browser.getVersion` all time out                                                                                                       |
| Paseo web, minified bundle (27 MB)    | 0.42%         | 0%              | Visually the same (`shots-paseo/paseo-prod-side.webp`). But `document.body.innerText` is `""` (Chromium: 342 chars), the `<noscript>` text appears in the ARIA tree, and every button has a 0×0 rect (verdict, point 1) |

Flows (`scripts/moli-trial/next-flow.mjs`), all the same as Chromium:

- **Client routing:** a `next/link` click goes from `/about` to `/canvas` with no document load. `Page.navigatedWithinDocument` fires and a window marker survives.
- **Cookie login:** a trusted-input click and `insertText` into the real form, then submit. The 303 sets an httpOnly `session` cookie, which is hidden from `document.cookie`. After `Browser.close` and a relaunch on the same profile, `/dashboard` renders "Welcome, moli".
- **Animation:** `requestAnimationFrame` runs at about 50 Hz in Moli and 60 Hz in Chromium. A CSS animation and a comma-syntax canvas both produce new screencast frames.

To serve Paseo's app as a minified bundle I used `scripts/moli-trial/expo-prod-proxy.mjs`. It rewrites the bundle URL to `dev=false&minify=true`, so no app build was needed.

## 4. Memory

`scripts/moli-trial/memory.mjs`: one fresh browser per run; 1, 3 or 9 tabs spread over up to 3 browser contexts. Tabs cycle through Next home, Paseo web (27 MB bundle, connected to a dev daemon), the layout fixture and Next canvas. So 1 tab is a light page, 3 tabs include one Paseo tab, and 9 tabs include three. The values are the sum of `Pss` and `Rss` from `/proc/<pid>/smaps_rollup` over the whole process tree, 6 s after the last load, as the median of 3 samples. Three runs each. The table shows the median run, with the range in brackets.

| Tabs (contexts)    | Moli PSS          | Headless shell PSS | Chrome `--headless=new` PSS | Moli RSS | Shell RSS | Chrome RSS |
| ------------------ | ----------------- | ------------------ | --------------------------- | -------- | --------- | ---------- |
| 0 (idle, launched) | 14                | 150 (142–150)      | 319 (306–320)               | 18       | 378       | 1,075      |
| 1 (1)              | **75** (75–75)    | 176 (164–176)      | 338 (323–338)               | 80       | 421       | 1,123      |
| 3 (3)              | **232** (232–236) | 442 (415–444)      | 634 (633–636)               | 237      | 838       | 1,764      |
| 9 (3)              | **410** (405–411) | 770 (747–774)      | 872 (831–898)               | 448      | 1,659     | 2,641      |

All values in MB. Processes in the tree: Moli 1; shell 6 / 8 / 14; Chrome 13 / 16 / 22.

- Moli uses 43% of the shell's PSS for one light tab and 53% for nine tabs. It uses 22% of Chrome's for one tab and 47% for nine. Each Paseo tab costs Moli about 150 MB, so heavy SPAs narrow the gap. Moli's "73 MB vs 773 MB" claim matches Moli's one-light-tab number against Chrome's multi-process RSS, which counts shared pages once per process. PSS is the fair measure.
- Runs repeated closely. The only outliers are in open time, not memory. Moli's first 9-tab run took 29 s to open, against 14–16 s for the others: all tabs share one process, so loads queue behind the two 27 MB Paseo bundles, and the first run also paid the cold cache. One shell 1-tab run took 1.2 s to open a light page, against about 0.2 s, on a cold profile.
- Moli's per-tab JavaScript has no process isolation. A tab that hangs, like the 55 MB case, stalls every context on that server. The current one-browser-per-workspace design limits that to one workspace. A shared Moli would spread it to all.

## 5. Live viewing

`scripts/moli-trial/screencast.mjs`: a 5 s window per measurement. CPU is the whole process tree. Click-to-pixel is the time from `Input.dispatchMouseEvent` to the first screencast frame whose centre pixel shows the new colour (20 clicks).

| Engine (interval)  | Animating page fps | CPU while streaming | Static page fps | Click → pixel p50 / p95 | Screenshot polling (shots/s, p50 latency, CPU) |
| ------------------ | ------------------ | ------------------- | --------------- | ----------------------- | ---------------------------------------------- |
| Moli (default 1 s) | 1                  | 9%                  | 0.2             | 836 / 910 ms            | 35/s, 24 ms, 74%                               |
| Moli 100 ms        | 6                  | 18%                 | 0.2             | 100 / 124 ms            | 46/s, 20 ms, 89%                               |
| Moli 33 ms         | 14                 | 35%                 | 0.2             | 51 / 105 ms             | 39/s, 22 ms, 83%                               |
| Moli 16 ms         | 25                 | 55%                 | 0.2             | 70 / 198 ms             | 35/s, 23 ms, 75%                               |
| Headless shell     | 53                 | 118%                | 0.2             | 70 / 186 ms             | 8/s, 125 ms, 40%                               |
| Chrome headless    | 38                 | 86%                 | 0.2             | 90 / 839 ms             | 8/s, 119 ms, 36%                               |

CPU without a viewer on the animating page: Moli 7%, shell 14%, Chrome 19%. On the static page all three are at 0%.

- Moli streams continuously and emits frames only when the page changes, like Chromium. An idle page costs nothing. The interval caps the rate. At 33 ms it matches the 15 fps the hub sends to a relayed viewer, and a click shows up as fast as on Chromium. Frames are 20 KB against Chromium's 11 KB at JPEG quality 60.
- The interval is a server flag, not a per-tab `startScreencast` parameter, so per-viewer rate control stays in Paseo's screencast hub, which already does it.
- Polling is not needed. If it were, Moli captures in about 20 ms where Chromium takes about 120 ms, but back-to-back polling keeps nearly one core busy.

## 6. Bot checks (informational only)

`scripts/moli-trial/botcheck.mjs`, public test pages only, no logins. Headed Chrome ran under a private Xvfb.

| Signal                     | Moli                                                       | Headless shell                                                                          | Headed Chrome 153             |
| -------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------- |
| User agent                 | Windows, Chrome 156 (on a Linux host)                      | `HeadlessChrome/145`, Linux                                                             | Chrome 153, Linux             |
| `navigator.webdriver`      | false                                                      | true                                                                                    | false                         |
| bot.sannysoft.com failures | 0                                                          | 8 (HEADCHR_UA, CHROME_OBJ, PERMISSIONS, IFRAME, CHR_MEMORY, WebDriver, Chrome, Plugins) | 0                             |
| WebGL                      | none (empty vendor and renderer)                           | SwiftShader                                                                             | none under Xvfb               |
| Broken image dimensions    | 0×0 (Chromium: 16×16)                                      | 16×16                                                                                   | 16×16                         |
| CreepJS headless score     | 31% like headless, 0% headless, 0% stealth; WebRTC blocked | 100% like headless, 44% headless                                                        | 0% like headless, 0% headless |
| arh.antoinevastel.com      | 502 from the site for all three                            |                                                                                         |                               |

Moli presents a Windows desktop Chrome by default. That passes the simple checks, but the platform is inconsistent with a Linux host. A fingerprinting site can still separate it by the missing WebGL, the 0×0 broken image and WebRTC.

## What Paseo would need to support Moli as an engine option

In the order you would hit them:

1. **An engine abstraction over the launch.** Moli has no `--remote-debugging-pipe`. Spawn it on an ephemeral loopback port and connect over WebSocket (Moli rejects cross-origin browser requests by default). `engine-on-moli.mts` shows that the WebSocket-to-`CdpConnection` bridge is about 30 lines. The pipe's guarantee is lost: nothing else can attach, and the browser dies with the daemon. Replace it with a loopback port that only the daemon knows, plus `prctl(PR_SET_PDEATHSIG)` or a process-group kill on daemon exit.
2. **Always stop with `Browser.close`.** Moli loses storage on SIGTERM, so the 3 s SIGKILL fallback in `WorkspaceBrowser.close` must stay the last resort, never the first.
3. **Launch flags:** `--layout -r --screencast-interval-ms 33 -P <profile>`. Do not pass `--block-private-networks`: workspace dev servers are on localhost. `executablePath` resolution would gain a `moli` source.
4. **Force layout before geometry.** Before `snapshot` and actionability checks, trigger a paint (a `Page.captureScreenshot` at small `clip`, or a Moli-specific layout refresh if they add one). Until that is fixed upstream it doubles snapshot cost, and coordinate clicks on React Native Web pages are wrong.
5. **Phone viewport:** send `mobile: false` with a 390×844 dpr 2 override and touch emulation on Moli. Accept that `screen` and the mobile layout viewport are not emulated, or hide the Phone option on Moli tabs.
6. **One Moli per workspace**, as Chromium is today, not one shared Moli with contexts. Moli has a single process, so one hung page stalls every context in it. At about 14 MB idle, a process per workspace costs little.
7. **Upstream bugs to file with Moli** before an engine option is worth building: large scripts hang the whole server (55 MB; 20 MB works); stale geometry on React Native Web; `innerText` returns `""` on the same pages; `<noscript>` content shows in the DOM tree while JS runs; canvas `fillStyle` ignores CSS Color 4; `<img>` SVG with `filter: invert()` renders as an empty box; form controls draw placeholders as text; storage is lost on SIGTERM; `mobile: true` emulation is missing.

## Reproduce

Scripts are in `scripts/moli-trial/`. Put the Moli binary at `/tmp/moli-bin/moli` (or set `MOLI_BIN`). Each script starts its browsers in their own process group and kills the group, so it never touches port 6767 or the shared Chrome on 9222.

```bash
node scripts/moli-trial/cdp-probe.mjs moli            # CDP coverage table rows (also: shell, chrome)
npx tsx scripts/moli-trial/engine-on-moli.mts moli    # Paseo's ServerBrowserHost on Moli (shell = control)
node scripts/moli-trial/persistence.mjs moli
node scripts/moli-trial/screencast.mjs moli 33        # fps, CPU, click→pixel, polling
scripts/moli-trial/setup-next.sh /tmp/moli-next       # then: npx next start -H 127.0.0.1 -p 3791
node scripts/moli-trial/next-flow.mjs moli
node scripts/moli-trial/expo-prod-proxy.mjs 3794 8191 # Paseo web as a minified bundle (Expo web on 8191)
node scripts/moli-trial/render-compare.mjs <outDir> name=url[@waitMs] ...
node scripts/moli-trial/aria-real-page.mjs moli http://127.0.0.1:3794/
node scripts/moli-trial/memory.mjs moli 3 <url> <url> ...
node scripts/moli-trial/botcheck.mjs <outDir>
```
