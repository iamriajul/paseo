# Web build Browser devtools bridge — design

**Date:** 2026-09-02
**Status:** Approved for implementation planning
**Scope:** Make the web build's Browser behave like a browser. The daemon injects a bridge script into proxied preview HTML; the app uses it for real navigation history, a URL bar that follows in-page navigation, eruda devtools, and click-to-select element attachments. Non-proxied URLs still load, degraded, under a sticky notice that says why.

## Problem

[Web build Browser localhost routing](2026-08-23-web-browser-localhost-routing-design.md) shipped the transport: `{port}.preview.host` reverse-proxies a daemon's loopback ports, and `web-preview-url.ts` silently resolves a typed `localhost:3000` onto it. What shipped with it is a two-control pane — a URL field and a reload button that remounts the iframe.

Everything else a browser does is missing, and [browser-localhost-routing.md](../../browser-localhost-routing.md) records why:

> **The address bar does not follow in-page navigation.** A cross-origin `<iframe>` emits no navigation events to its parent, so once a page navigates itself — a client-side route change, a redirect — Paseo's address bar keeps showing the last URL it set. Electron's `<webview>` exposes navigation events; a plain `<iframe>` does not, and there is no clean fix.

That conclusion is wrong, and this design is what makes it wrong. The parent frame is blind, but the daemon is not: it already sits in the response path for every preview request, so it can put a script inside the frame that reports what the parent cannot see. Vibe Kanban ([BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban), Apache-2.0) solves it exactly this way, and its UX is the reference for this feature rather than something invented here.

The Electron pane (`pane/index.electron.tsx`) meanwhile has back, forward, stop/reload, devtools, annotate-element and screenshot-element. Web has none of them. The gap is not a platform limit — it is an unbuilt bridge.

## Goals

- The URL bar follows in-page navigation, including SPA route changes, and keeps displaying `localhost:<port>/path` rather than the preview origin.
- Back, forward and reload operate on the page's real history.
- eruda devtools toggle from the toolbar — console, elements, network, resources, sources.
- Click an element to attach it to the chat composer, reusing the attachment pipeline the Electron pane already uses.
- Any URL loads. A non-loopback URL goes straight into the iframe and is expected to be limited by iframe rules.
- A sticky notice on non-proxied URLs explains the limitation and points at the desktop app.
- Device/viewport presets, already modelled and unused on web, take effect.

## Non-goals

- **Element screenshot capture on web.** Electron's path is the `captureElement` main-process bridge; an iframe has no equivalent. Web's select-as-context is text-only.
- **Proxying arbitrary non-loopback URLs through the daemon.** That would make the daemon an open forward proxy — an SSRF and open-relay problem — to buy injection on sites the user does not control. Out of the question; the notice covers this case instead.
- **Electron and Android.** Both load loopback through engine-level proxies and never touch `browser-preview`, so injection cannot reach them and they need nothing from it. eruda is web-in-web only.
- **Relay hosts**, which advertise no template and keep the existing unavailable state.

## Options considered

**Inject a bridge script into proxied HTML.** Chosen. The only mechanism that gives the parent frame any visibility into a cross-origin child, and the daemon is already in the response path. Cost is an HTML-rewriting stage in the proxy.

**Capability flag on `server_info`.** Rejected in favour of self-announcement. The obvious move is `browserPreview.bridge: true` alongside the existing `urlTemplate`, gated per [protocol-compatibility.md](../../protocol-compatibility.md). But the injected script already has to post a `ready` message, and treating its absence as "degrade" detects strictly more than a flag does: an old daemon, a non-HTML response, an HTML document with no injection point, and an injection that failed all produce the same correct fallback. A flag would claim the capability for all four. Self-announcement also leaves `packages/protocol/src/messages.ts` untouched, removing a rebase conflict this fork would otherwise carry forever.

**Same-origin proxying of the whole web (path prefix or otherwise), to get injection everywhere.** Rejected on security, as above.

**`postMessage` polling of `location.href` only, with no history patching.** Rejected. It catches the URL change but produces no back/forward semantics, and a 150 ms poll is a poor substitute for `pushState` interception that fires synchronously.

## Architecture

```
  app origin                                    daemon                  daemon machine
┌──────────────────────────────┐        ┌──────────────────────┐        ┌────────────┐
│ toolbar                      │        │ browser-preview      │        │ dev server │
│    │  commands               │        │   proxy              │        │ 127.0.0.1  │
│    ▼                         │        │    │                 │        │   :3000    │
│ web-bridge ──postMessage──┐  │        │    ▼                 │        │            │
│    ▲                      ▼  │  HTTP  │ inject transform ────┼─ HTTP ─┤            │
│    │   ┌──────────────────┐  ├───────►│   <head> + scripts   │◄───────┤            │
│    └───┤ iframe           │  │◄───────┤                      │        │            │
│ events │  + injected JS   │  │  HTML  └──────────────────────┘        └────────────┘
│        └──────────────────┘  │
└──────────────────────────────┘
        {port}.preview.host is the origin the iframe loads; the daemon serves it
```

The iframe lives in the app, on the app's origin's page, but loads the preview origin — so it is cross-origin to its own parent. The injected script is the only thing that crosses that boundary in either direction, and it carries four message types up and seven commands down.

### Injection point

Injection targets `<head>`, falling back to `<body ...>`, then `</body>`, then giving up. Vibe Kanban injects before `</body>`; this design injects at `<head>` deliberately, because the `history.pushState` patch must be installed **before the page's own JavaScript runs**. A route change during hydration is otherwise unobserved, and the first `navigation` message the parent receives is already wrong.

### Streaming

The transform buffers only until it finds an injection point, emits prefix plus scripts, then passes the remainder through untouched. A 64 KB cap bounds the buffering; past it the response streams unmodified rather than being held. Streaming SSR — React 18, Next.js app router — keeps streaming, which a buffer-the-whole-body implementation would silently break.

`content-encoding` of gzip, deflate or br is piped through the matching `zlib` decompressor first, and the response goes out identity with `content-encoding` and `content-length` dropped, so Node falls back to chunked. An unrecognised encoding disables injection and passes bytes through untouched. Only `text/html` enters this path at all; bundles, images and HMR traffic keep today's `pipe()` and stay compressed.

### Meta CSP

`transformPreviewResponseHeaders` already strips `content-security-policy` headers so the page can be framed. A `<meta http-equiv="content-security-policy">` inside the document survives that and would block both the jsdelivr script tag and the inline bridge. It is removed in the same rewriting pass.

## Bridge protocol

Iframe → parent, posted with target `'*'` because the daemon cannot know the app's origin:

| Message            | Payload                                             |
| ------------------ | --------------------------------------------------- |
| `ready`            | `{docId}`                                           |
| `navigation`       | `{docId, seq, url, title, canGoBack, canGoForward}` |
| `selection`        | `BrowserElementSelection`                           |
| `select-cancelled` | `{}`                                                |

Parent → iframe, targeted at the exact preview origin:

`back` · `forward` · `reload` · `goto {url}` · `toggle-eruda` · `start-select` · `cancel-select`

**Both ends authenticate, and they defend against different things.**

The parent accepts a message only when `event.source === iframe.contentWindow` **and** `event.origin === previewOrigin`, then parses the payload with zod. `seq` and `docId` let it drop out-of-order and stale-document messages.

The child accepts a command only when `event.source === window.parent`, and `goto` additionally allowlists `http:`/`https:` before touching `location`. An earlier draft of this spec put authentication on the parent alone; that was a conflation of two directions, caught in review of Task 3. Parent-side checks protect the parent from spoofed inbound messages and say nothing about who may command the child — and they cannot mitigate the child-side vector at all, because an attack executing inside the preview origin produces messages that are perfectly authentic on both parent checks.

The vector is concrete. A previewed page may embed third-party frames — ads, checkout widgets, video, chat — and a descendant frame can reach `window.parent`. A source-string-only check therefore hands any embedded frame the ability to navigate its embedder, which the web platform otherwise denies it: a browsing context may navigate another only if it is an ancestor, same-origin, or the top with user activation. With an unvalidated `goto`, that becomes `javascript:` execution in the embedder's origin — script access to an origin the frame had none in.

It stays out of Critical because a compromise is contained to one preview origin: preview content is served on its own per-port hostname, while the daemon's control plane is matched by path on the daemon's own host, so there are no daemon cookies, no daemon API, and no filesystem reach. The trust argument that covers the rest of this design — the user chose to run this dev server — does not extend to third-party frames the developer never wrote.

## Injected scripts

Three concerns, composed into one inline script, authored as template-literal modules in `browser-preview/inject/` — the convention already used by `browser-element-attachment.ts` and `element-selector.electron.ts`, and one that avoids a build-time asset-copy step.

**Navigation.** Patches `history.pushState`/`replaceState`, listens on `popstate`, `hashchange`, `pageshow` and `load`, maintains a stack and index, and posts `navigation`. `sessionStorage` persists the stack across full page loads as an enhancement only — Safari partitions third-party storage — so the in-memory stack stays authoritative and every storage access is wrapped in `try`/`catch`.

**eruda.** Appends `https://cdn.jsdelivr.net/npm/eruda@3.4.3/eruda.js` on `DOMContentLoaded`, inits with the dark theme, and hides eruda's floating entry button so the Paseo toolbar is the only control. Pinned at 3.4.3, current at time of writing and the version Vibe Kanban pins. CDN delivery means devtools are unavailable on a fully offline client or behind an ingress CSP that blocks jsdelivr; that is an accepted trade for keeping ~1.4 MB out of the server package.

**Selector.** A click-to-select overlay producing the same `BrowserElementSelection` shape the Electron pane produces, posted back as `selection`.

## App behaviour

New fork-owned modules beside `pane/index.web.tsx`. None of them touch `pane/index.electron.tsx`: at 1911 lines it is an official file, and lifting shared chrome out of it would buy a merge conflict on every upstream sync for no behavioural gain. Duplicating a toolbar is the cheaper side of that trade.

| Module                        | Job                                                          |
| ----------------------------- | ------------------------------------------------------------ |
| `web-bridge.ts`               | postMessage client, origin validation, zod schemas           |
| `web-navigation.ts`           | pure reducer merging bridge state with a parent-side stack   |
| `web-toolbar.tsx`             | back / forward / reload / URL / viewport / devtools / select |
| `web-notice.tsx`              | sticky iframe-limitation banner                              |
| `web-annotation-composer.tsx` | comment box shown before attaching                           |

Two navigation models behind one toolbar:

- **Preview URLs.** The bridge is authoritative. Back, forward and reload are commands; the URL bar follows in-page navigation and is translated back to `localhost:<port>/path` for display. The preview origin is never shown.
- **Direct URLs.** A parent-side stack of URL-bar navigations only, since in-page navigation is unobservable. Navigating **remounts the iframe** rather than assigning `src` — assigning `src` pushes an entry onto the _top-level_ history and would hijack the app's own back button.

Toolbar controls that depend on the bridge render disabled until `ready` arrives, so a direct URL or an old daemon shows an honestly inert control rather than one that silently does nothing.

Attachments reuse the platform-neutral path: `buildBrowserElementAttachment` → `buildBrowserAttachmentScopeKey` → `appendWorkspaceAttachment`. The pane already receives `cwd`, `workspaceId` and `serverId` and currently ignores all three; they are exactly the scope key's inputs.

Viewport reads `BrowserRecord.viewport` and `device-presets.ts`, both already modelled and unused on web.

## The notice

Full width, one line, directly beneath the toolbar, shown whenever the resolved src is `direct`. Not dismissible: it describes a condition that persists for as long as the tab is on that URL, and it removes itself when navigation reaches a proxied URL. English copy, with the eight other locales following:

> This page is running inside an iframe, so some sites refuse to load and devtools aren't available. Use the desktop app for a full browser.

## Degradation

|                             | Preview (loopback) | Direct (any URL)               |
| --------------------------- | ------------------ | ------------------------------ |
| Loads                       | yes                | until the site refuses framing |
| URL bar follows in-page nav | yes                | no                             |
| Back / forward              | full history       | URL-bar navigations only       |
| Reload                      | real reload        | remount                        |
| eruda / select element      | yes                | no                             |
| Notice                      | hidden             | shown                          |

## Security posture

Injection reaches any client that loads a preview origin, not only the Paseo iframe. That origin already serves every loopback port on the daemon's machine to anyone who can resolve its hostname — the trade documented under [Configuration](../../browser-localhost-routing.md#configuration) — so injection widens the blast radius of a preview origin by no meaningful amount.

The bridge does introduce one boundary worth stating rather than implying: a page inside the preview can post any `selection` payload it likes, and that payload becomes text in the chat composer that an agent will read. The page is the user's own dev server, which they chose to run and which already executes their code, so this is consistent with the trust already extended to it. It is not a new capability for a hostile third party, because a hostile third party cannot get onto the preview origin in the first place.

Parent-side origin and source checks stop an unrelated frame from impersonating the bridge.

## Fork constraints

`browser-preview/` is fork-owned and stays that way; the injection stage is new files in that directory, not a change to shared proxy code. `pane/index.web.tsx` is an official file that already carries a fork delta, and the new modules beside it are fork-only.

No change to `packages/protocol`, by the self-announcement decision above.

A new `docs/fork-decisions.md` entry, `browser-web-devtools-bridge`, with a proof command that fails without the change.

## Testing

Focused files only, per [testing.md](../../testing.md):

```bash
npx vitest run packages/server/src/server/browser-preview/html-injection.test.ts packages/server/src/server/browser-preview/index.test.ts --bail=1
npx vitest run packages/app/src/desktop/browser/pane/web-bridge.test.ts packages/app/src/desktop/browser/pane/web-navigation.test.ts --bail=1
```

`html-injection.test.ts` covers each injection point in priority order, the 64 KB cap, meta-CSP removal, and non-HTML passthrough. Gzip and brotli round-trips go into the existing `index.test.ts` real-server harness rather than a new mock. `web-bridge.test.ts` covers rejection of foreign origins and mismatched sources, and schema rejection. `web-navigation.test.ts` covers stack semantics for the direct-URL model.

## Docs

- Rewrite the **Web build** section of `browser-localhost-routing.md` to cover injection, and **delete** the address-bar bullet from Known limitations — it is the limitation this work removes, and leaving a corrected paragraph next to the stale claim is how that doc would start becoming a pile.
- Add the `browser-web-devtools-bridge` fork decision.
