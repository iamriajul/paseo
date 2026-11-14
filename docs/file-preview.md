# File preview

Opening a file in a workspace opens a file tab (`packages/app/src/file-pane/pane.tsx`). The tab stats the file, picks a panel from the catalog (`file-panels/catalog.ts`), and mounts it. A binary file no panel claims shows "Binary preview unavailable" with a Download button.

## Panels

| Panel    | Files                                             | Web and Electron                                                                | iOS and Android                                            |
| -------- | ------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Source   | Every text file no other built-in claims          | CodeMirror editor up to 1 MB, read-only view up to 50 MB (highlighted to 10 MB) | Read-only, highlighted to 1 MB, plain to 10 MB. No editing |
| Markdown | `.md`, `.markdown`                                | Rendered preview beside Source                                                  | Same                                                       |
| HTML     | `.html`, `.htm`                                   | Sandboxed iframe beside Source                                                  | WebView beside Source                                      |
| Table    | `.csv`, `.tsv`, `.tab`                            | Table beside Source                                                             | Same                                                       |
| JSON     | `.json`, `.jsonc`, `.jsonl`, `.ndjson`            | Foldable tree beside Source                                                     | Same                                                       |
| Log      | `.log`                                            | The file's end, followed as it grows, beside Source                             | Same                                                       |
| Image    | `.png .jpg .jpeg .gif .webp .svg .bmp .ico .avif` | Zoom and pan, pages through the folder's images                                 | Same, drawn by `expo-image`                                |
| PDF      | `.pdf`                                            | react-pdf, no text layer                                                        | react-native-pdf                                           |
| Media    | `file-panels/media/formats.ts`                    | Streams with seeking, see [Audio and video](#audio-and-video)                   | Loads into the app cache, then plays                       |
| Office   | Word, Excel and PowerPoint Open XML               | Rendered in the page                                                            | Rendered in a WebView                                      |

Table, JSON, Log, PDF, Media and Office are fallback panels: they step aside when a plugin panel claims the same file, so a plugin user sees what they saw before the fork added the panel. A binary file then opens in the plugin without asking; a text file offers the plugin and Source. Source, the floor for text files, does not count as a claim (`withoutFallbacks` in `file-panels/resolve.ts`), or no text fallback would ever open. Why the fork added them: [pdf-file-preview](fork-decisions.md#pdf-file-preview), [office-file-preview](fork-decisions.md#office-file-preview), [media-file-preview](fork-decisions.md#media-file-preview), [table-json-file-preview](fork-decisions.md#table-json-file-preview), [log-file-tail](fork-decisions.md#log-file-tail). A plugin panel can claim any extension or filename; see [Plugins](plugins.md).

Table and JSON open on their preview, like Markdown, and on Source for a line target. JSON reads comments and trailing commas, so `tsconfig.json` and VS Code settings parse; a JSON Lines file shows one entry per line, keyed by line number. A document of up to 1,500 values opens fully expanded and a larger one opens on its top-level entries, so `package-lock.json` shows its outline instead of 40,000 rows.

Source highlights the languages `packages/highlight/src/parsers.ts` lists, by extension or, for `Dockerfile`, `Containerfile`, `Gemfile` and the like, by name. The same parsers color diffs on the daemon. A language without a Lezer grammar comes from `@codemirror/legacy-modes` through `StreamLanguage`, as Swift, Dart, shell, SQL, TOML, Dockerfile, Kotlin, Ruby and Lua do.

## The file tab's toolbar

Every file tab starts with one toolbar row: the file's size, the panel's own controls, then the tab's actions (`file-panels/actions.tsx`). Panels with a toolbar of their own (Source, Markdown, HTML, Table, JSON, Log) put the actions at its end; the tab draws the row above every other panel, plugin panels included, and above "Binary preview unavailable" and "too large" states.

- **Show changes** appears when Changes lists the file, with the file's added and removed lines, and opens Changes focused on it. It reads the same diff subscription as the Changes view, under the comparison and whitespace setting Changes uses, so with both open the daemon diffs once, and the file's lines match what Changes shows. A file outside the workspace never has it.
- **Download** saves the file on web and Electron; on iOS and Android the same button is **Share** and hands the file to the share sheet. It runs through the download store like Files' Download (`hooks/use-file-download.ts`).

## How bytes reach a panel

Every panel except Media and Log reads through the tab's `FileHandle` (`file-panels/file/handle.ts`). `readText`, `readBytes` and `url()` read the whole file over the session, so an image, PDF or Office file costs its full size in app memory, and the tab shows a spinner until all of it has arrived. Those three panels open files up to 64 MB on web and Electron and 32 MB on iOS and Android (`file-panels/whole-file-limit.ts`); a larger file shows "too large to preview here" and Download. Source checks the size before it reads and refuses files over its limits. Media and Log read byte ranges (`file-panels/byte-range.ts`).

Text is UTF-8, with or without a BOM, or UTF-16 in either byte order, told by its BOM (`file-panels/file/text-encoding.ts`). Saving writes the text back in the encoding it was read in. UTF-16's NUL bytes look binary to the daemon's UTF-8 checks, so the daemon names the encoding in the file version's `textEncoding` and keeps `kind: "binary"`: apps from before it decode every text file as UTF-8 and would show such a file as garbage. Saving UTF-16 needs `features.fileByteWrites`, like any byte write.

On iOS and Android the image panel draws with `expo-image` (`components/zoomable-viewport/platform-image.tsx`): React Native's `Image` cannot decode SVG on either platform, nor AVIF before iOS 16 and Android 12. It caches nothing, because a file tab's image keeps its URL when the file changes on disk.

## Log files

A log panel reads the last 256 KB of the file with a byte-range read, then, each time the file changes, only the bytes past what it has read (`file-panels/log/tail.ts`). It never reads the whole file, so a log of any size opens at once over a relay. Load earlier reads the 256 KB before the first line on screen.

- A read that starts mid-file starts mid-line and maybe mid-character, so the tail skips to the first newline. Bytes appended later go through one streaming `TextDecoder`, so a character split between two writes stays whole.
- A file that shrinks was truncated or rotated, and the tail starts over at its new end.
- Changes reported while a read runs collapse into one read after it, so a chatty log costs one read per round trip.
- The tail keeps 50,000 lines and drops the oldest past that; Load earlier reads them again.
- Lines have one height and scroll sideways instead of wrapping. That keeps the list's row offsets exact, so earlier lines land above the view without moving it, on web too, where `maintainVisibleContentPosition` does nothing.
- At the bottom the view follows new lines; scrolled up it stays put and shows Jump to end. Terminal colors and titles are stripped, not drawn.

Source shows the whole file when it fits Source's budget, and opens first for a line target, whose line the tail cannot place. A host without `downloadRange` opens logs in Source and shows "Update the host" on Tail.

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
