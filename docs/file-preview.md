# File preview

Opening a file in a workspace opens a file tab (`packages/app/src/file-pane/pane.tsx`). The tab stats the file, picks a panel from the catalog (`file-panels/catalog.ts`), and mounts it. A binary file no panel claims shows "Binary preview unavailable" and its size.

## Panels

| Panel    | Files                                    | Web and Electron                                                                | iOS and Android                                            |
| -------- | ---------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Source   | Every text file no other built-in claims | CodeMirror editor up to 1 MB, read-only view up to 50 MB (highlighted to 10 MB) | Read-only, highlighted to 1 MB, plain to 10 MB. No editing |
| Markdown | `.md`, `.markdown`                       | Rendered preview beside Source                                                  | Same                                                       |
| HTML     | `.html`, `.htm`                          | Sandboxed iframe beside Source                                                  | WebView beside Source                                      |
| Image    | `.png .jpg .jpeg .gif .webp .svg`        | Zoom and pan, pages through the folder's images                                 | Same                                                       |
| PDF      | `.pdf`                                   | react-pdf, no text layer                                                        | react-native-pdf                                           |
| Media    | `file-panels/media/formats.ts`           | Streams with seeking, see [Audio and video](#audio-and-video)                   | Loads into the app cache, then plays                       |
| Office   | Word, Excel and PowerPoint Open XML      | Rendered in the page                                                            | Rendered in a WebView                                      |

PDF, Media and Office are fallback panels: a plugin panel that claims the same file opens it instead, without asking. Why the fork added them: [pdf-file-preview](fork-decisions.md#pdf-file-preview), [office-file-preview](fork-decisions.md#office-file-preview), [media-file-preview](fork-decisions.md#media-file-preview). A plugin panel can claim any extension or filename; see [Plugins](plugins.md).

## How bytes reach a panel

Every panel except Media reads through the tab's `FileHandle` (`file-panels/file/handle.ts`). `readText`, `readBytes` and `url()` read the whole file over the session, so an image, PDF or Office file costs its full size in app memory. Source checks the size before it reads and refuses files over its limits.

## Audio and video

A media player reads a URL and seeks with Range requests. Relay, SSH and socket connections have no daemon URL, and a web page cannot give a player one either, so the panel reads byte ranges over the session instead: `fs.download.open` with `offset` and `length`, behind `server_info.features.downloadRange`. It never reads the whole file to play it.

**Web and Electron** play through a service worker, `packages/app/public/media-stream/sw.js`:

- A media element's requests reach a service worker only from a document that worker controls, and the worker's scope is `/media-stream/`, so the app's own pages never pass through it. The player therefore lives in `frame.html`, inside that scope. The page builds the `<video>` or `<audio>` element in the frame itself, which needs the same origin, so the frame has `sandbox="allow-same-origin"` and runs no script.
- The worker keeps no state. For each request to `/media-stream/<id>/file` it asks every app window which one published `<id>`. That page answers with the status and headers for the Range header (`media/range.ts`), then sends a chunk per pull (`media/stream-server.web.ts`). A restarted worker still serves the next request.
- The page pings the worker every 10 seconds while a stream is published: browsers stop an idle worker after about 30 seconds, which would cut a playing stream.
- Electron's `paseo://` scheme allows service workers only with `allowServiceWorkers` in `packages/desktop/src/main.ts`. Electron dev loads `http://localhost`, where the worker works without it, so check the scheme with the exported build: export it with `PASEO_WEB_PLATFORM=electron npx expo export --platform web` in `packages/app`, then start Electron with `EXPO_DEV_URL=paseo://app`, which loads `packages/app/dist`.
- A page without service workers (plain HTTP on a LAN address) plays the file from memory, up to 64 MB.
- The daemon drops a download nobody has read for a minute. Chrome holds a stream idle that long during ordinary playback: a 40-minute mp3 buffered 819 seconds ahead, then read nothing more. When the next read fails, Chromium asks again from where it stopped with a new Range request, so the panel does not reopen reads itself.
- Round trips set the latency, not bandwidth. Each range costs an open and a first read, and an mp4 with its index at the end needs two ranges before it has metadata. Measured on a 57 MB, 120 s mp4 at the relay's ~430 ms round trip: metadata 4.1 s after opening, then 1.7 s from play and 2.4 s from a seek until half a second had played. On a direct connection the same three took 0.9 s, 0.5 s and 0.9 s.

**iOS and Android** play with `expo-video`, which needs a URL, and only a direct connection has a daemon URL. The file streams over the session into `cache/media-preview/` and plays from there with full seeking. A file over 50 MB waits for a tap, so opening one never spends a phone's data unasked. The copy is deleted when the panel closes. `expo-video` is required only once the binary is known to have it, so an over-the-air bundle on an older binary shows "Update the app" instead of crashing.

To QA, use an mp4 whose index is at the end (ffmpeg's default without `-movflags +faststart`): opening it already needs a second range. Record the Range headers of `/media-stream/*/file` requests and the element's `buffered` ranges. Chromium reports media from a non-HTTP scheme as fully buffered, so in Electron the Range headers are the only evidence of partial reads.
