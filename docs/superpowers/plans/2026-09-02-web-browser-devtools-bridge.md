# Web build Browser devtools bridge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the web build's Browser behave like a browser — real navigation history, a URL bar that follows in-page navigation, eruda devtools, and click-to-select element attachments — by injecting a bridge script into daemon-proxied preview HTML.

**Architecture:** The daemon's `browser-preview` proxy gains a streaming HTML rewriting stage that inserts a bridge script into the `<head>` of `text/html` responses. That script patches `history.pushState`/`replaceState`, loads eruda on demand, and runs a click-to-select overlay, reporting to the parent frame over `postMessage`. The app's web Browser pane consumes those messages for its toolbar state and sends commands back. Non-proxied URLs get no bridge and show a sticky notice explaining the iframe limits.

**Tech Stack:** Node `http` + `zlib` + `stream.Transform` (daemon), Express middleware, React Native Web + Unistyles + zustand (app), zod (message validation), vitest.

**Spec:** [`docs/superpowers/specs/2026-09-02-web-browser-devtools-bridge-design.md`](../specs/2026-09-02-web-browser-devtools-bridge-design.md)

## Global Constraints

- **No changes to `packages/protocol`.** The bridge announces itself with a `ready` message; its absence means degrade. This is a deliberate rejection of a `server_info` capability flag — see the spec's Options considered.
- **Do not modify `packages/app/src/desktop/browser/pane/index.electron.tsx`.** It is an official file of 1911 lines; new web chrome lives in new fork-owned modules beside it, even where that duplicates a small component.
- **eruda is pinned at `https://cdn.jsdelivr.net/npm/eruda@3.4.3/eruda.js`.** Do not add eruda as an npm dependency.
- **Injection applies only to `text/html` responses** on the preview origin. Every other content type keeps today's `upstreamRes.pipe(res)`.
- **Scan window cap is 65536 bytes** (`INJECTION_SCAN_LIMIT_BYTES`). Past it, the response streams unmodified.
- **Never show the preview origin in the URL bar.** It always displays the `localhost:<port>/path` form.
- **Run after every task:** `npm run format && npm run lint && npm run typecheck`.
- **Never run a full test suite.** Only the specific files named in each task, with `--bail=1`.
- **i18n:** every new user-facing string goes into all nine locale files — `en, ar, es, fr, ja, ko, pt-BR, ru, zh-CN` — under `packages/app/src/i18n/resources/`.

---

### Task 1: HTML head rewriting (pure)

The string surgery, with no streams or HTTP involved. Everything subtle about injection — where the script goes, what a doctype forbids, meta CSP — is decided here and tested without I/O.

**Files:**

- Create: `packages/server/src/server/browser-preview/html-injection.ts`
- Test: `packages/server/src/server/browser-preview/html-injection.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `INJECTION_SCAN_LIMIT_BYTES: number` (65536)
  - `findHeadInjectionOffset(html: string): number` — byte offset to insert at
  - `stripMetaCsp(html: string): string`
  - `rewriteHtmlHead(windowText: string, scripts: string): string`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/server/browser-preview/html-injection.test.ts
import { describe, expect, it } from "vitest";
import {
  INJECTION_SCAN_LIMIT_BYTES,
  findHeadInjectionOffset,
  rewriteHtmlHead,
  stripMetaCsp,
} from "./html-injection.js";

const SCRIPTS = "<script>BRIDGE</script>";

describe("findHeadInjectionOffset", () => {
  it("inserts immediately after <head>", () => {
    const html = "<!doctype html><html><head><title>x</title></head><body></body></html>";
    expect(findHeadInjectionOffset(html)).toBe(html.indexOf("<head>") + "<head>".length);
  });

  it("handles <head> with attributes", () => {
    const html = `<html><head data-x="1"><title>x</title></head></html>`;
    expect(findHeadInjectionOffset(html)).toBe(html.indexOf(">", html.indexOf("<head")) + 1);
  });

  it("is case-insensitive", () => {
    const html = "<!DOCTYPE HTML><HTML><HEAD></HEAD></HTML>";
    expect(findHeadInjectionOffset(html)).toBe(html.indexOf("<HEAD>") + "<HEAD>".length);
  });

  // A script before <!doctype html> throws the document into quirks mode, which
  // silently changes layout in the page we are supposed to be previewing faithfully.
  it("never inserts before a doctype", () => {
    const html = "<!doctype html><html><body>hi</body></html>";
    const offset = findHeadInjectionOffset(html);
    expect(offset).toBeGreaterThanOrEqual("<!doctype html>".length);
  });

  it("falls back to after <html> when there is no head", () => {
    const html = "<!doctype html><html><body>hi</body></html>";
    expect(findHeadInjectionOffset(html)).toBe(html.indexOf("<html>") + "<html>".length);
  });

  it("falls back to after the doctype when there is no html element", () => {
    const html = "<!doctype html><body>hi</body>";
    expect(findHeadInjectionOffset(html)).toBe("<!doctype html>".length);
  });

  it("returns 0 for a bare fragment", () => {
    expect(findHeadInjectionOffset("<div>hi</div>")).toBe(0);
  });
});

describe("stripMetaCsp", () => {
  it("removes a meta CSP tag", () => {
    const html = `<head><meta http-equiv="Content-Security-Policy" content="default-src 'self'"><title>x</title></head>`;
    const out = stripMetaCsp(html);
    expect(out).not.toContain("Content-Security-Policy");
    expect(out).toContain("<title>x</title>");
  });

  it("removes the report-only variant and single-quoted attributes", () => {
    const html = `<meta http-equiv='content-security-policy-report-only' content='x'>`;
    expect(stripMetaCsp(html)).toBe("");
  });

  it("leaves unrelated meta tags alone", () => {
    const html = `<meta charset="utf-8"><meta name="viewport" content="width=device-width">`;
    expect(stripMetaCsp(html)).toBe(html);
  });
});

describe("rewriteHtmlHead", () => {
  it("inserts the scripts and strips meta CSP in one pass", () => {
    const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="x"><title>t</title></head><body></body></html>`;
    const out = rewriteHtmlHead(html, SCRIPTS);
    expect(out).not.toContain("Content-Security-Policy");
    expect(out.indexOf(SCRIPTS)).toBe(out.indexOf("<head>") + "<head>".length);
    expect(out).toContain("<title>t</title>");
  });

  it("puts the bridge before any page script", () => {
    const html = `<html><head><script src="/app.js"></script></head><body></body></html>`;
    const out = rewriteHtmlHead(html, SCRIPTS);
    expect(out.indexOf(SCRIPTS)).toBeLessThan(out.indexOf("/app.js"));
  });

  it("exposes a 64 KiB scan limit", () => {
    expect(INJECTION_SCAN_LIMIT_BYTES).toBe(65536);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/src/server/browser-preview/html-injection.test.ts --bail=1`
Expected: FAIL — `Failed to resolve import "./html-injection.js"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/server/src/server/browser-preview/html-injection.ts

// Bounds how much of a response is held in memory looking for an injection
// point. Past it the body streams unmodified: a document whose <head> has not
// closed inside 64 KiB is not one worth delaying.
export const INJECTION_SCAN_LIMIT_BYTES = 65536;

// Matches <meta http-equiv="content-security-policy"> and its report-only
// variant, in either attribute order and with any quoting style.
const META_CSP_PATTERN =
  /<meta\b(?=[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy(?:-report-only)?["']?)[^>]*>/gi;

function offsetAfterOpenTag(html: string, tagName: string): number | null {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>`, "i");
  const match = pattern.exec(html);
  if (match === null) return null;
  return match.index + match[0].length;
}

export function findHeadInjectionOffset(html: string): number {
  const head = offsetAfterOpenTag(html, "head");
  if (head !== null) return head;

  const htmlTag = offsetAfterOpenTag(html, "html");
  if (htmlTag !== null) return htmlTag;

  // Nothing may precede the doctype: a node before it puts the whole document
  // into quirks mode, which changes the layout of the page we are previewing.
  const doctype = /<!doctype\b[^>]*>/i.exec(html);
  if (doctype !== null) return doctype.index + doctype[0].length;

  return 0;
}

export function stripMetaCsp(html: string): string {
  return html.replace(META_CSP_PATTERN, "");
}

export function rewriteHtmlHead(windowText: string, scripts: string): string {
  const stripped = stripMetaCsp(windowText);
  const offset = findHeadInjectionOffset(stripped);
  return stripped.slice(0, offset) + scripts + stripped.slice(offset);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/src/server/browser-preview/html-injection.test.ts --bail=1`
Expected: PASS, 13 tests.

- [ ] **Step 5: Format, lint, typecheck**

Run: `npm run format && npm run lint && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/server/browser-preview/html-injection.ts packages/server/src/server/browser-preview/html-injection.test.ts
git commit -m "feat(browser-preview): add HTML head rewriting for bridge injection"
```

---

### Task 2: Streaming injection transform

Task 1 rewrites a string. This makes it a stream that holds only the head.

**Files:**

- Modify: `packages/server/src/server/browser-preview/html-injection.ts`
- Modify: `packages/server/src/server/browser-preview/html-injection.test.ts`

**Interfaces:**

- Consumes: `rewriteHtmlHead`, `INJECTION_SCAN_LIMIT_BYTES` from Task 1.
- Produces: `createHtmlInjectionStream(scripts: string): Transform`

- [ ] **Step 1: Write the failing test**

Append to `html-injection.test.ts`:

```ts
import { Readable } from "node:stream";
import { createHtmlInjectionStream } from "./html-injection.js";

async function pump(chunks: readonly (string | Buffer)[], scripts: string): Promise<string> {
  const stream = Readable.from(
    chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))),
  ).pipe(createHtmlInjectionStream(scripts));
  const out: Buffer[] = [];
  for await (const chunk of stream) out.push(chunk as Buffer);
  return Buffer.concat(out).toString("utf8");
}

describe("createHtmlInjectionStream", () => {
  it("injects once and passes the body through", async () => {
    const out = await pump(
      ["<!doctype html><html><head><title>t</title></head>", "<body>hello</body></html>"],
      SCRIPTS,
    );
    expect(out).toContain(SCRIPTS);
    expect(out).toContain("<body>hello</body>");
    expect(out.split(SCRIPTS)).toHaveLength(2);
  });

  // The insertion point can straddle a chunk boundary; a naive per-chunk
  // implementation silently misses it and the page loads with no bridge.
  it("finds an injection point split across chunks", async () => {
    const out = await pump(["<!doctype html><ht", "ml><he", "ad></head><body></body>"], SCRIPTS);
    expect(out).toContain(SCRIPTS);
    expect(out.indexOf(SCRIPTS)).toBeGreaterThan(out.indexOf("<head>"));
  });

  it("strips meta CSP appearing after the injection point", async () => {
    const out = await pump(
      [`<html><head><meta http-equiv="Content-Security-Policy" content="x"></head><body>b</body>`],
      SCRIPTS,
    );
    expect(out).not.toContain("Content-Security-Policy");
    expect(out).toContain("<body>b</body>");
  });

  it("stops buffering after </head> so the body streams", async () => {
    const big = "x".repeat(200_000);
    const out = await pump([`<html><head></head><body>${big}</body></html>`], SCRIPTS);
    expect(out).toContain(SCRIPTS);
    expect(out).toContain(big);
  });

  it("passes through unmodified when no injection point arrives within the cap", async () => {
    const filler = `<!-- ${"y".repeat(INJECTION_SCAN_LIMIT_BYTES)} -->`;
    const out = await pump([filler, "<html><head></head>"], SCRIPTS);
    expect(out).not.toContain(SCRIPTS);
    expect(out).toBe(`${filler}<html><head></head>`);
  });

  it("still injects when the stream ends before </head>", async () => {
    const out = await pump(["<html><head><title>only</title>"], SCRIPTS);
    expect(out).toContain(SCRIPTS);
  });

  // Splits a 3-byte character down the middle, across the chunk boundary. A
  // transform that decodes each accumulated chunk as utf8 turns the halves
  // into U+FFFD and this assertion fails.
  it("does not corrupt a multi-byte character split across chunks", async () => {
    const full = Buffer.from("<html><head></head><body>日本語テキスト</body></html>", "utf8");
    const splitAt = full.indexOf(Buffer.from("日", "utf8")) + 1;
    const out = await pump([full.subarray(0, splitAt), full.subarray(splitAt)], SCRIPTS);
    expect(out).toContain("日本語テキスト");
    expect(out).not.toContain("�");
  });

  // Same hazard on the give-up path: the raw bytes must pass through
  // untouched rather than surviving a decode round-trip.
  it("does not corrupt multi-byte content when it gives up at the cap", async () => {
    const filler = Buffer.from(`<!-- ${"y".repeat(INJECTION_SCAN_LIMIT_BYTES)} 日本語 -->`, "utf8");
    const splitAt = filler.indexOf(Buffer.from("日", "utf8")) + 1;
    const out = await pump([filler.subarray(0, splitAt), filler.subarray(splitAt)], SCRIPTS);
    expect(out).toContain("日本語");
    expect(out).not.toContain("�");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/src/server/browser-preview/html-injection.test.ts --bail=1`
Expected: FAIL — `createHtmlInjectionStream is not exported`.

- [ ] **Step 3: Write minimal implementation**

Append to `html-injection.ts`:

```ts
import { Transform } from "node:stream";

// Buffers until </head> closes (or the cap, or end of stream), rewrites that
// window once, then passes every later byte through untouched. Holding only the
// head is what lets streaming SSR keep streaming: buffering the whole document
// would serialise a Suspense-streamed page into one late flush.
export function createHtmlInjectionStream(scripts: string): Transform {
  let pending: Buffer | null = Buffer.alloc(0);

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (pending === null) {
        // Window already emitted: straight passthrough, byte for byte.
        callback(null, chunk);
        return;
      }

      pending = Buffer.concat([pending, chunk]);

      // Search in latin1, never utf8. Decoding a partial buffer replaces a
      // multi-byte character split across a chunk boundary with U+FFFD, and
      // re-encoding then ships the corruption downstream. latin1 is
      // byte-preserving and 1 byte == 1 char, so a match index here is a byte
      // offset — and every tag we look for is ASCII either way.
      const headEnd = /<\/head\s*>/i.exec(pending.toString("latin1"));

      if (headEnd !== null) {
        const boundary = headEnd.index + headEnd[0].length;
        // The boundary sits just past '>', an ASCII byte, so the window never
        // ends mid-character and decoding it as utf8 is safe.
        const windowText = pending.subarray(0, boundary).toString("utf8");
        const rest = pending.subarray(boundary);
        pending = null;
        this.push(Buffer.from(rewriteHtmlHead(windowText, scripts), "utf8"));
        callback(null, rest.byteLength > 0 ? rest : undefined);
        return;
      }

      if (pending.byteLength >= INJECTION_SCAN_LIMIT_BYTES) {
        // Gave up looking. Emit the raw bytes untouched — no decode round-trip.
        const raw = pending;
        pending = null;
        callback(null, raw);
        return;
      }
      callback();
    },
    flush(callback) {
      if (pending === null) {
        callback();
        return;
      }
      // Stream ended before </head>. The whole buffer is the window, and it is
      // complete, so utf8 decoding is safe here.
      const windowText = pending.toString("utf8");
      pending = null;
      this.push(Buffer.from(rewriteHtmlHead(windowText, scripts), "utf8"));
      callback();
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/src/server/browser-preview/html-injection.test.ts --bail=1`
Expected: PASS, 21 tests (13 from Task 1 plus 8 new).

- [ ] **Step 5: Format, lint, typecheck**

Run: `npm run format && npm run lint && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/server/browser-preview/html-injection.ts packages/server/src/server/browser-preview/html-injection.test.ts
git commit -m "feat(browser-preview): stream head rewriting without buffering the body"
```

---

### Task 3: Navigation bridge script

The script that makes the parent frame able to see anything. Authored as a template-literal module, matching `browser-element-attachment.ts` and `element-selector.electron.ts`.

**Files:**

- Create: `packages/server/src/server/browser-preview/inject/navigation-script.ts`
- Create: `packages/server/src/server/browser-preview/inject/navigation-script.test.ts`
- Create: `packages/server/src/server/browser-preview/inject/protocol.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `protocol.ts`: `BRIDGE_SOURCE = "paseo-browser-bridge"`, `COMMAND_SOURCE = "paseo-browser"`
  - `navigation-script.ts`: `NAVIGATION_SCRIPT: string`

Add `jsdom` to `packages/server` devDependencies — the script is DOM glue and its stack logic is the risky part; a node-only assertion on the string would test nothing.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/server/browser-preview/inject/navigation-script.test.ts
// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { BRIDGE_SOURCE, COMMAND_SOURCE } from "./protocol.js";
import { NAVIGATION_SCRIPT } from "./navigation-script.js";

interface BridgeMessage {
  source: string;
  type: string;
  payload: Record<string, unknown>;
}

function runScript(): BridgeMessage[] {
  const sent: BridgeMessage[] = [];
  vi.spyOn(window.parent, "postMessage").mockImplementation((message: unknown) => {
    sent.push(message as BridgeMessage);
  });
  // eslint-disable-next-line no-new-func
  new Function(NAVIGATION_SCRIPT)();
  return sent;
}

describe("NAVIGATION_SCRIPT", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/start");
    vi.restoreAllMocks();
  });

  it("announces itself with ready", () => {
    const sent = runScript();
    expect(sent.some((m) => m.source === BRIDGE_SOURCE && m.type === "ready")).toBe(true);
  });

  it("reports the initial navigation with canGoBack false", () => {
    const sent = runScript();
    const nav = sent.filter((m) => m.type === "navigation").at(-1);
    expect(nav?.payload.canGoBack).toBe(false);
    expect(nav?.payload.canGoForward).toBe(false);
    expect(String(nav?.payload.url)).toContain("/start");
  });

  it("reports a pushState route change and enables back", () => {
    const sent = runScript();
    history.pushState(null, "", "/next");
    const nav = sent.filter((m) => m.type === "navigation").at(-1);
    expect(String(nav?.payload.url)).toContain("/next");
    expect(nav?.payload.canGoBack).toBe(true);
  });

  it("does not grow the stack on replaceState", () => {
    const sent = runScript();
    history.replaceState(null, "", "/replaced");
    const nav = sent.filter((m) => m.type === "navigation").at(-1);
    expect(String(nav?.payload.url)).toContain("/replaced");
    expect(nav?.payload.canGoBack).toBe(false);
  });

  it("increments seq so the parent can drop stale messages", () => {
    const sent = runScript();
    history.pushState(null, "", "/a");
    history.pushState(null, "", "/b");
    const seqs = sent.filter((m) => m.type === "navigation").map((m) => Number(m.payload.seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("navigates on a goto command from the parent", () => {
    runScript();
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign, href: window.location.href },
      writable: true,
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: COMMAND_SOURCE, command: "goto", url: "http://localhost:3000/x" },
      }),
    );
    expect(assign).toHaveBeenCalledWith("http://localhost:3000/x");
  });

  it("ignores messages from an unknown source", () => {
    runScript();
    const back = vi.spyOn(history, "back");
    window.dispatchEvent(
      new MessageEvent("message", { data: { source: "somebody-else", command: "back" } }),
    );
    expect(back).not.toHaveBeenCalled();
  });

  it("survives sessionStorage being unavailable", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => runScript()).not.toThrow();
    getItem.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/src/server/browser-preview/inject/navigation-script.test.ts --bail=1`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/server/src/server/browser-preview/inject/protocol.ts

// Messages the injected bridge sends up to the app.
export const BRIDGE_SOURCE = "paseo-browser-bridge";
// Commands the app sends down to the injected bridge.
export const COMMAND_SOURCE = "paseo-browser";
```

```ts
// packages/server/src/server/browser-preview/inject/navigation-script.ts
import { BRIDGE_SOURCE, COMMAND_SOURCE } from "./protocol.js";

// Runs inside the previewed page, injected into <head> so the history patch is
// installed before the page's own JavaScript. A route change during hydration
// is otherwise unobserved and the parent's first URL is already stale.
//
// Posts with targetOrigin '*': the daemon writing this script cannot know the
// app's origin. The payload carries no secrets, and the parent authenticates by
// checking event.source and event.origin on its side.
export const NAVIGATION_SCRIPT = `
(function() {
  'use strict';
  var BRIDGE = ${JSON.stringify(BRIDGE_SOURCE)};
  var COMMAND = ${JSON.stringify(COMMAND_SOURCE)};
  var STORAGE_KEY = '__paseo_nav';
  var docId = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  var stack = [];
  var index = -1;
  var seq = 0;
  var lastHref = null;

  function send(type, payload) {
    try { window.parent.postMessage({ source: BRIDGE, type: type, payload: payload }, '*'); }
    catch (error) { /* parent gone */ }
  }

  // sessionStorage is partitioned or blocked for third-party frames in some
  // browsers, so it is an enhancement across full page loads and never the
  // source of truth. Every access is guarded.
  function load() {
    try {
      var saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && Array.isArray(saved.stack) && typeof saved.index === 'number') {
        stack = saved.stack.filter(function(entry) { return typeof entry === 'string'; });
        index = Math.min(saved.index, stack.length - 1);
      }
    } catch (error) { stack = []; index = -1; }
  }

  function save() {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ stack: stack, index: index })); }
    catch (error) { /* storage blocked */ }
  }

  function report() {
    seq += 1;
    send('navigation', {
      docId: docId,
      seq: seq,
      url: location.href,
      title: document.title || '',
      canGoBack: index > 0,
      canGoForward: index >= 0 && index < stack.length - 1
    });
  }

  function observe(mode) {
    var href = location.href;
    if (mode !== 'replace' && href === lastHref) return;
    lastHref = href;
    if (mode === 'replace' && index >= 0) {
      stack[index] = href;
    } else if (mode === 'push') {
      stack = stack.slice(0, index + 1);
      stack.push(href);
      index = stack.length - 1;
    } else {
      var existing = stack.indexOf(href);
      if (existing >= 0) { index = existing; }
      else { stack = stack.slice(0, index + 1); stack.push(href); index = stack.length - 1; }
    }
    save();
    report();
  }

  var originalPush = history.pushState;
  var originalReplace = history.replaceState;
  history.pushState = function() {
    var result = originalPush.apply(this, arguments);
    observe('push');
    return result;
  };
  history.replaceState = function() {
    var result = originalReplace.apply(this, arguments);
    observe('replace');
    return result;
  };

  window.addEventListener('popstate', function() { observe('auto'); });
  window.addEventListener('hashchange', function() { observe('auto'); });
  window.addEventListener('pageshow', function() { observe('auto'); });
  window.addEventListener('load', function() { observe('auto'); });

  window.addEventListener('message', function(event) {
    var data = event.data;
    if (!data || data.source !== COMMAND) return;
    switch (data.command) {
      case 'back': if (index > 0) history.back(); break;
      case 'forward': if (index < stack.length - 1) history.forward(); break;
      case 'reload': location.reload(); break;
      case 'goto':
        if (typeof data.url === 'string' && data.url) location.assign(data.url);
        break;
    }
  });

  // Catches navigations no event covers — a same-document change made by a
  // router that writes location directly.
  setInterval(function() { if (location.href !== lastHref) observe('auto'); }, 250);

  load();
  send('ready', { docId: docId });
  observe('auto');
})();
`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/src/server/browser-preview/inject/navigation-script.test.ts --bail=1`
Expected: PASS, 8 tests.

- [ ] **Step 5: Format, lint, typecheck**

Run: `npm run format && npm run lint && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/server/browser-preview/inject/ packages/server/package.json package-lock.json
git commit -m "feat(browser-preview): add navigation bridge script"
```

---

### Task 4: eruda and selector scripts, composed bundle

**Files:**

- Create: `packages/server/src/server/browser-preview/inject/eruda-script.ts`
- Create: `packages/server/src/server/browser-preview/inject/selector-script.ts`
- Create: `packages/server/src/server/browser-preview/inject/index.ts`
- Create: `packages/server/src/server/browser-preview/inject/index.test.ts`

**Interfaces:**

- Consumes: `BRIDGE_SOURCE`, `COMMAND_SOURCE` (Task 3); `NAVIGATION_SCRIPT` (Task 3).
- Produces: `buildInjectedScripts(): string` — the complete `<script>` markup inserted by Task 5.

`selector-script.ts` produces the same `BrowserElementSelection` shape the Electron pane produces (`url`, `selector`, `tag`, `text`, `outerHTML`, `computedStyles`, `boundingRect`, `reactSource`, `parentChain`, `children`) so `buildBrowserElementAttachment` accepts it unchanged. Port the selection logic from `packages/app/src/desktop/browser/pane/element-selector.electron.ts:155` (`buildElementSelectorScript`), replacing its `window.__paseoSelectorResult` polling handoff with a `postMessage` of type `selection`, and its session-token guard with the `COMMAND_SOURCE` check.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/server/browser-preview/inject/index.test.ts
import { describe, expect, it } from "vitest";
import { buildInjectedScripts } from "./index.js";
import { BRIDGE_SOURCE } from "./protocol.js";

describe("buildInjectedScripts", () => {
  const scripts = buildInjectedScripts();

  it("pins eruda at the audited version", () => {
    expect(scripts).toContain("https://cdn.jsdelivr.net/npm/eruda@3.4.3/eruda.js");
  });

  it("includes navigation, eruda and selector", () => {
    expect(scripts).toContain(BRIDGE_SOURCE);
    expect(scripts).toContain("eruda");
    expect(scripts).toContain("paseo-selector");
  });

  it("emits balanced script tags", () => {
    const open = scripts.match(/<script\b/g) ?? [];
    const close = scripts.match(/<\/script>/g) ?? [];
    expect(open.length).toBe(close.length);
    expect(open.length).toBeGreaterThan(0);
  });

  // An unescaped </script> inside a template literal terminates the injected
  // block early and dumps the remaining script source into the page as text.
  it("contains no raw closing script tag inside inline source", () => {
    const inline = scripts
      .split(/<\/script>/)
      .slice(0, -1)
      .join("");
    expect(inline).not.toMatch(/<\/script\b/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/src/server/browser-preview/inject/index.test.ts --bail=1`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/server/src/server/browser-preview/inject/eruda-script.ts
import { BRIDGE_SOURCE, COMMAND_SOURCE } from "./protocol.js";

export const ERUDA_CDN_URL = "https://cdn.jsdelivr.net/npm/eruda@3.4.3/eruda.js";

// Loaded from a CDN rather than bundled: keeping ~1.4 MB out of the server
// package is worth devtools being unavailable on a fully offline client.
export const ERUDA_SCRIPT = `
(function() {
  'use strict';
  var BRIDGE = ${JSON.stringify(BRIDGE_SOURCE)};
  var COMMAND = ${JSON.stringify(COMMAND_SOURCE)};
  var loading = false;
  var ready = false;

  function send(type, payload) {
    try { window.parent.postMessage({ source: BRIDGE, type: type, payload: payload }, '*'); }
    catch (error) { /* parent gone */ }
  }

  function initEruda() {
    if (ready || typeof window.eruda === 'undefined') return;
    window.eruda.init({ defaults: { theme: 'Dark' } });
    window.eruda.hide();
    // The Paseo toolbar owns the toggle; eruda's floating button would be a
    // second control for the same thing, overlapping the previewed page.
    try { window.eruda._entryBtn._$el[0].style.display = 'none'; } catch (error) {}
    ready = true;
    send('eruda-ready', {});
  }

  function load(onReady) {
    if (ready) { onReady(); return; }
    if (loading) return;
    loading = true;
    var tag = document.createElement('script');
    tag.src = ${JSON.stringify(ERUDA_CDN_URL)};
    tag.onload = function() { initEruda(); onReady(); };
    tag.onerror = function() { loading = false; send('eruda-failed', {}); };
    (document.head || document.documentElement).appendChild(tag);
  }

  window.addEventListener('message', function(event) {
    // Sender check first. A previewed page may embed third-party frames (ads,
    // checkout widgets, video), and a descendant frame can reach window.parent
    // — so a source-string-only check hands any embedded frame the ability to
    // drive this bridge, a capability the web platform otherwise denies it.
    // Task 6 posts app-window -> iframe.contentWindow, so event.source here is
    // exactly window.parent.
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.source !== COMMAND || data.command !== 'toggle-eruda') return;
    load(function() {
      if (!window.eruda) return;
      if (window.eruda._isShow) window.eruda.hide();
      else window.eruda.show();
    });
  });
})();
`;
```

```ts
// packages/server/src/server/browser-preview/inject/index.ts
import { ERUDA_SCRIPT } from "./eruda-script.js";
import { NAVIGATION_SCRIPT } from "./navigation-script.js";
import { SELECTOR_SCRIPT } from "./selector-script.js";

// </script> inside inline source would close the block early and spill the rest
// of the script into the page as visible text.
function escapeInlineScript(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

export function buildInjectedScripts(): string {
  return [NAVIGATION_SCRIPT, ERUDA_SCRIPT, SELECTOR_SCRIPT]
    .map((source) => `<script>${escapeInlineScript(source)}</script>`)
    .join("");
}
```

Write `selector-script.ts` as described above, exporting `SELECTOR_SCRIPT: string`, registering `window.__paseoSelector`, responding to `start-select` and `cancel-select`, and posting `selection` / `select-cancelled`.

**Its command handler carries the same two guards Task 3's does, and for the same reasons** (Task 3 review, findings 1 and 2): reject any message whose `event.source !== window.parent` before looking at `data.source`, and never hand an unvalidated string to a navigation or URL sink. A source-string-only check gives every third-party frame embedded in the previewed page a capability the web platform deliberately denies it — navigating or driving its embedder.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/src/server/browser-preview/inject/index.test.ts --bail=1`
Expected: PASS, 4 tests.

- [ ] **Step 5: Format, lint, typecheck**

Run: `npm run format && npm run lint && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/server/browser-preview/inject/
git commit -m "feat(browser-preview): add eruda and element selector bridge scripts"
```

---

### Task 5: Wire injection into the preview proxy

**Files:**

- Modify: `packages/server/src/server/browser-preview/index.ts:76-93` (the `middleware()` response handler)
- Modify: `packages/server/src/server/browser-preview/index.test.ts`

**Interfaces:**

- Consumes: `createHtmlInjectionStream` (Task 2), `buildInjectedScripts` (Task 4), `transformPreviewResponseHeaders` (existing).
- Produces: no new exports; `createBrowserPreviewSubsystem`'s signature is unchanged.

- [ ] **Step 1: Write the failing test**

Add an HTML route to the existing `upstream` server in `beforeEach`, before the catch-all:

```ts
if (req.url === "/page") {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><html><head><title>t</title></head><body>hi</body></html>");
  return;
}
if (req.url === "/gzipped") {
  res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
  res.end(gzipSync("<!doctype html><html><head><title>t</title></head><body>hi</body></html>"));
  return;
}
```

with `import { gzipSync } from "node:zlib";` at the top.

**Use the existing `get()` helper's shape, which is fetch-like, not node-like:** the body is `await res.text()` (not `res.body`) and headers are `res.headers.get(name)` returning `string | null` (not `res.headers[name]` returning `undefined`). Assert absent headers with `.toBeNull()`.

Note the host must name the **upstream** port so the proxy dials the test server — `${upstreamPort}.preview.example.com`, exactly as the existing cases do. A literal `3000.` would dial a port nothing is listening on.

Then append these cases:

```ts
it("injects the bridge into an HTML response", async () => {
  const res = await get("/page", `${upstreamPort}.preview.example.com`);
  const body = await res.text();
  expect(body).toContain("paseo-browser-bridge");
  expect(body).toContain("<title>t</title>");
  expect(body).toContain("<body>hi</body>");
});

it("injects into a gzipped HTML response and drops the encoding", async () => {
  const res = await get("/gzipped", `${upstreamPort}.preview.example.com`);
  expect(await res.text()).toContain("paseo-browser-bridge");
  expect(res.headers.get("content-encoding")).toBeNull();
});

// A stale content-length truncates the injected document at exactly the
// pre-injection byte count, which reads as a corrupt page.
it("drops content-length when it injects", async () => {
  const res = await get("/page", `${upstreamPort}.preview.example.com`);
  expect(res.headers.get("content-length")).toBeNull();
});

it("leaves non-HTML responses untouched", async () => {
  const res = await get("/", `${upstreamPort}.preview.example.com`);
  const body = await res.text();
  expect(body).toBe("upstream-body");
  expect(body).not.toContain("paseo-browser-bridge");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/src/server/browser-preview/index.test.ts --bail=1`
Expected: FAIL — body has no `paseo-browser-bridge`.

- [ ] **Step 3: Write minimal implementation**

In `index.ts`, add imports and two helpers, then replace the body of `upstream.on("response", ...)`:

```ts
import zlib from "node:zlib";
import { createHtmlInjectionStream } from "./html-injection.js";
import { buildInjectedScripts } from "./inject/index.js";

const INJECTED_SCRIPTS = buildInjectedScripts();

function isHtmlResponse(headers: NodeJS.Dict<string | string[]>): boolean {
  const contentType = headers["content-type"];
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  return typeof value === "string" && value.toLowerCase().includes("text/html");
}

// Returns null when the encoding is one we cannot decode, which disables
// injection rather than corrupting the body.
function createDecompressor(
  headers: NodeJS.Dict<string | string[]>,
): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | "identity" | null {
  const raw = headers["content-encoding"];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.toLowerCase().trim();
  if (value === undefined || value === "" || value === "identity") return "identity";
  if (value === "gzip" || value === "x-gzip") return zlib.createGunzip();
  if (value === "deflate") return zlib.createInflate();
  if (value === "br") return zlib.createBrotliDecompress();
  return null;
}
```

```ts
upstream.on("response", (upstreamRes) => {
  const stripped = stripHopByHopHeaders(upstreamRes.headers);
  const decompressor = isHtmlResponse(stripped) ? createDecompressor(stripped) : null;

  if (decompressor === null) {
    const headers = transformPreviewResponseHeaders({
      headers: stripped,
      targetPort: port,
      template,
    });
    res.writeHead(upstreamRes.statusCode ?? 502, headers);
    upstreamRes.pipe(res);
    return;
  }

  // The injected bytes invalidate both, and the response now goes out
  // identity, so Node falls back to chunked transfer.
  delete stripped["content-length"];
  delete stripped["content-encoding"];
  const headers = transformPreviewResponseHeaders({
    headers: stripped,
    targetPort: port,
    template,
  });
  res.writeHead(upstreamRes.statusCode ?? 502, headers);

  const injector = createHtmlInjectionStream(INJECTED_SCRIPTS);
  injector.on("error", (error) => {
    logger.debug({ err: error, port }, "browser_preview_injection_failed");
    res.end();
  });

  if (decompressor === "identity") {
    upstreamRes.pipe(injector).pipe(res);
    return;
  }
  decompressor.on("error", (error) => {
    logger.debug({ err: error, port }, "browser_preview_decompress_failed");
    res.end();
  });
  upstreamRes.pipe(decompressor).pipe(injector).pipe(res);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/src/server/browser-preview/index.test.ts --bail=1`
Expected: PASS, all existing cases plus 4 new.

- [ ] **Step 5: Format, lint, typecheck**

Run: `npm run format && npm run lint && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/server/browser-preview/index.ts packages/server/src/server/browser-preview/index.test.ts
git commit -m "feat(browser-preview): inject the bridge into proxied HTML responses"
```

---

### Task 6: App-side bridge client

**Files:**

- Create: `packages/app/src/desktop/browser/pane/web-bridge.ts`
- Create: `packages/app/src/desktop/browser/pane/web-bridge.test.ts`

**Interfaces:**

- Consumes: the wire shapes from Task 3 and Task 4 (`ready`, `navigation`, `selection`, `select-cancelled`, `eruda-ready`, `eruda-failed`).
- Produces:
  - `BridgeEvent` — discriminated union on `type`
  - `BridgeCommand` — `{command:"back"|"forward"|"reload"|"toggle-eruda"|"start-select"|"cancel-select"} | {command:"goto"; url:string}`
  - `createPreviewBridge(options: {origin: string; getFrame: () => Window | null; onEvent: (event: BridgeEvent) => void; listenTarget?: Window}): {dispose(): void; send(command: BridgeCommand): void}`

- [ ] **Step 1: Write the failing test**

```ts
// packages/app/src/desktop/browser/pane/web-bridge.test.ts
import { describe, expect, it, vi } from "vitest";
import { type BridgeEvent, createPreviewBridge } from "./web-bridge";

const ORIGIN = "https://3000.preview.example.com";

function harness() {
  const handlers = new Set<(event: MessageEvent) => void>();
  const frame = { postMessage: vi.fn() } as unknown as Window;
  const listenTarget = {
    addEventListener: (_t: string, handler: (event: MessageEvent) => void) => {
      handlers.add(handler);
    },
    removeEventListener: (_t: string, handler: (event: MessageEvent) => void) => {
      handlers.delete(handler);
    },
  } as unknown as Window;
  const events: BridgeEvent[] = [];
  const bridge = createPreviewBridge({
    origin: ORIGIN,
    getFrame: () => frame,
    onEvent: (event) => events.push(event),
    listenTarget,
  });
  const deliver = (data: unknown, overrides: Partial<MessageEvent> = {}) => {
    for (const handler of handlers) {
      handler({ data, origin: ORIGIN, source: frame, ...overrides } as MessageEvent);
    }
  };
  return { bridge, events, frame, deliver };
}

const navigation = {
  source: "paseo-browser-bridge",
  type: "navigation",
  payload: {
    docId: "d1",
    seq: 1,
    url: "http://localhost:3000/a",
    title: "A",
    canGoBack: false,
    canGoForward: false,
  },
};

describe("createPreviewBridge", () => {
  it("accepts a navigation message from the preview origin", () => {
    const { events, deliver } = harness();
    deliver(navigation);
    expect(events).toEqual([
      {
        type: "navigation",
        docId: "d1",
        seq: 1,
        url: "http://localhost:3000/a",
        title: "A",
        canGoBack: false,
        canGoForward: false,
      },
    ]);
  });

  it("rejects a message from a different origin", () => {
    const { events, deliver } = harness();
    deliver(navigation, { origin: "https://evil.example.com" });
    expect(events).toEqual([]);
  });

  it("rejects a message from a window that is not the frame", () => {
    const { events, deliver } = harness();
    deliver(navigation, { source: {} as Window });
    expect(events).toEqual([]);
  });

  it("rejects a foreign source field", () => {
    const { events, deliver } = harness();
    deliver({ ...navigation, source: "somebody-else" });
    expect(events).toEqual([]);
  });

  it("rejects a malformed payload rather than passing it on", () => {
    const { events, deliver } = harness();
    deliver({ ...navigation, payload: { seq: "one" } });
    expect(events).toEqual([]);
  });

  it("targets the preview origin exactly when sending", () => {
    const { bridge, frame } = harness();
    bridge.send({ command: "back" });
    expect(frame.postMessage).toHaveBeenCalledWith(
      { source: "paseo-browser", command: "back" },
      ORIGIN,
    );
  });

  it("sends goto with its url", () => {
    const { bridge, frame } = harness();
    bridge.send({ command: "goto", url: "http://localhost:3000/x" });
    expect(frame.postMessage).toHaveBeenCalledWith(
      { source: "paseo-browser", command: "goto", url: "http://localhost:3000/x" },
      ORIGIN,
    );
  });

  it("stops listening after dispose", () => {
    const { bridge, events, deliver } = harness();
    bridge.dispose();
    deliver(navigation);
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/app/src/desktop/browser/pane/web-bridge.test.ts --bail=1`
Expected: FAIL — cannot resolve `./web-bridge`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/app/src/desktop/browser/pane/web-bridge.ts
import { z } from "zod";

const BRIDGE_SOURCE = "paseo-browser-bridge";
const COMMAND_SOURCE = "paseo-browser";

const NavigationPayloadSchema = z.object({
  docId: z.string(),
  seq: z.number(),
  url: z.string(),
  title: z.string(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
});

const SelectionPayloadSchema = z.object({
  url: z.string(),
  selector: z.string(),
  tag: z.string(),
  text: z.string(),
  outerHTML: z.string(),
  computedStyles: z.record(z.string(), z.string()),
  boundingRect: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }),
  reactSource: z
    .object({
      fileName: z.string().nullable(),
      lineNumber: z.number().nullable(),
      columnNumber: z.number().nullable(),
      componentName: z.string().nullable(),
    })
    .nullable(),
  parentChain: z.array(z.string()),
  children: z.array(z.string()),
});

const MessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), payload: z.object({ docId: z.string() }) }),
  z.object({ type: z.literal("navigation"), payload: NavigationPayloadSchema }),
  z.object({ type: z.literal("selection"), payload: SelectionPayloadSchema }),
  z.object({ type: z.literal("select-cancelled"), payload: z.unknown() }),
  z.object({ type: z.literal("eruda-ready"), payload: z.unknown() }),
  z.object({ type: z.literal("eruda-failed"), payload: z.unknown() }),
]);

export type BridgeSelection = z.infer<typeof SelectionPayloadSchema>;

export type BridgeEvent =
  | { type: "ready"; docId: string }
  | ({ type: "navigation" } & z.infer<typeof NavigationPayloadSchema>)
  | { type: "selection"; selection: BridgeSelection }
  | { type: "select-cancelled" }
  | { type: "eruda-ready" }
  | { type: "eruda-failed" };

export type BridgeCommand =
  | { command: "back" | "forward" | "reload" | "toggle-eruda" | "start-select" | "cancel-select" }
  | { command: "goto"; url: string };

export interface PreviewBridge {
  send(command: BridgeCommand): void;
  dispose(): void;
}

export function createPreviewBridge(options: {
  origin: string;
  getFrame: () => Window | null;
  onEvent: (event: BridgeEvent) => void;
  listenTarget?: Window;
}): PreviewBridge {
  const target = options.listenTarget ?? window;

  const handleMessage = (event: MessageEvent): void => {
    // Both checks matter: origin alone would accept any frame served by the
    // preview host, and source alone would accept a frame that navigated away.
    if (event.origin !== options.origin) return;
    if (event.source !== options.getFrame()) return;

    const data = event.data as { source?: unknown } | null;
    if (!data || data.source !== BRIDGE_SOURCE) return;

    const parsed = MessageSchema.safeParse(data);
    if (!parsed.success) return;

    switch (parsed.data.type) {
      case "ready":
        options.onEvent({ type: "ready", docId: parsed.data.payload.docId });
        return;
      case "navigation":
        options.onEvent({ type: "navigation", ...parsed.data.payload });
        return;
      case "selection":
        options.onEvent({ type: "selection", selection: parsed.data.payload });
        return;
      default:
        options.onEvent({ type: parsed.data.type });
    }
  };

  target.addEventListener("message", handleMessage as EventListener);

  return {
    send(command) {
      options.getFrame()?.postMessage({ source: COMMAND_SOURCE, ...command }, options.origin);
    },
    dispose() {
      target.removeEventListener("message", handleMessage as EventListener);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/app/src/desktop/browser/pane/web-bridge.test.ts --bail=1`
Expected: PASS, 8 tests.

- [ ] **Step 5: Format, lint, typecheck**

Run: `npm run format && npm run lint && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/desktop/browser/pane/web-bridge.ts packages/app/src/desktop/browser/pane/web-bridge.test.ts
git commit -m "feat(app/browser): add preview bridge postMessage client"
```

---

### Task 7: Navigation state reducer

Two navigation models — bridge-authoritative for preview URLs, parent-tracked for direct URLs — reconciled in one pure reducer so the pane holds no branching logic.

**Files:**

- Create: `packages/app/src/desktop/browser/pane/web-navigation.ts`
- Create: `packages/app/src/desktop/browser/pane/web-navigation.test.ts`

**Interfaces:**

- Consumes: `BridgeEvent` (Task 6).
- Produces:
  - `WebNavigationState { displayUrl: string; title: string; canGoBack: boolean; canGoForward: boolean; bridgeReady: boolean; stack: readonly string[]; index: number; lastDocId: string | null; lastSeq: number }` — `lastDocId`/`lastSeq` are the stale-message guard; they are internal to the reducer and no consumer reads them.
  - `createWebNavigationState(url: string): WebNavigationState`
  - `WebNavigationAction` — `{type:"bridge"; event: BridgeEvent} | {type:"user-navigate"; url: string} | {type:"user-back"} | {type:"user-forward"} | {type:"reset"; url: string}`
  - `webNavigationReducer(state, action): WebNavigationState`

- [ ] **Step 1: Write the failing test**

```ts
// packages/app/src/desktop/browser/pane/web-navigation.test.ts
import { describe, expect, it } from "vitest";
import { createWebNavigationState, webNavigationReducer } from "./web-navigation";

const START = "http://localhost:3000/";

function nav(overrides: Record<string, unknown> = {}) {
  return {
    type: "bridge" as const,
    event: {
      type: "navigation" as const,
      docId: "d1",
      seq: 1,
      url: START,
      title: "Home",
      canGoBack: false,
      canGoForward: false,
      ...overrides,
    },
  };
}

describe("webNavigationReducer", () => {
  it("starts with the initial url and no history", () => {
    const state = createWebNavigationState(START);
    expect(state.displayUrl).toBe(START);
    expect(state.canGoBack).toBe(false);
    expect(state.bridgeReady).toBe(false);
  });

  it("marks the bridge ready", () => {
    const state = webNavigationReducer(createWebNavigationState(START), {
      type: "bridge",
      event: { type: "ready", docId: "d1" },
    });
    expect(state.bridgeReady).toBe(true);
  });

  it("takes url, title and history flags from the bridge", () => {
    const state = webNavigationReducer(
      createWebNavigationState(START),
      nav({ url: "http://localhost:3000/about", title: "About", canGoBack: true }),
    );
    expect(state.displayUrl).toBe("http://localhost:3000/about");
    expect(state.title).toBe("About");
    expect(state.canGoBack).toBe(true);
  });

  // Messages can arrive out of order; a stale one would drag the URL bar
  // backwards after the user already moved on.
  it("ignores a navigation message with a lower seq", () => {
    let state = webNavigationReducer(
      createWebNavigationState(START),
      nav({ seq: 5, url: "/five" }),
    );
    state = webNavigationReducer(state, nav({ seq: 2, url: "/two" }));
    expect(state.displayUrl).toBe("/five");
  });

  it("accepts a lower seq from a new document", () => {
    let state = webNavigationReducer(
      createWebNavigationState(START),
      nav({ seq: 5, url: "/five" }),
    );
    state = webNavigationReducer(state, nav({ seq: 1, url: "/fresh", docId: "d2" }));
    expect(state.displayUrl).toBe("/fresh");
  });

  it("tracks user navigations in its own stack when there is no bridge", () => {
    let state = createWebNavigationState(START);
    state = webNavigationReducer(state, { type: "user-navigate", url: "https://a.example" });
    state = webNavigationReducer(state, { type: "user-navigate", url: "https://b.example" });
    expect(state.canGoBack).toBe(true);
    expect(state.canGoForward).toBe(false);
    state = webNavigationReducer(state, { type: "user-back" });
    expect(state.displayUrl).toBe("https://a.example");
    expect(state.canGoForward).toBe(true);
  });

  it("truncates the forward entries on a new navigation", () => {
    let state = createWebNavigationState(START);
    state = webNavigationReducer(state, { type: "user-navigate", url: "https://a.example" });
    state = webNavigationReducer(state, { type: "user-back" });
    state = webNavigationReducer(state, { type: "user-navigate", url: "https://c.example" });
    expect(state.canGoForward).toBe(false);
    expect(state.stack).toEqual([START, "https://c.example"]);
  });

  it("lets the bridge override the parent stack once it is ready", () => {
    let state = createWebNavigationState(START);
    state = webNavigationReducer(state, { type: "user-navigate", url: "http://localhost:3000/a" });
    state = webNavigationReducer(state, { type: "bridge", event: { type: "ready", docId: "d1" } });
    state = webNavigationReducer(state, nav({ url: "http://localhost:3000/b", canGoBack: true }));
    expect(state.displayUrl).toBe("http://localhost:3000/b");
    expect(state.canGoBack).toBe(true);
  });

  it("clears bridge state on reset", () => {
    let state = webNavigationReducer(createWebNavigationState(START), {
      type: "bridge",
      event: { type: "ready", docId: "d1" },
    });
    state = webNavigationReducer(state, { type: "reset", url: "https://other.example" });
    expect(state.bridgeReady).toBe(false);
    expect(state.displayUrl).toBe("https://other.example");
    expect(state.canGoBack).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/app/src/desktop/browser/pane/web-navigation.test.ts --bail=1`
Expected: FAIL — cannot resolve `./web-navigation`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/app/src/desktop/browser/pane/web-navigation.ts
import type { BridgeEvent } from "./web-bridge";

export interface WebNavigationState {
  displayUrl: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  bridgeReady: boolean;
  // Parent-side history, used only while no bridge is reporting. In-page
  // navigation is invisible from here, so this tracks URL-bar moves alone.
  stack: readonly string[];
  index: number;
  lastDocId: string | null;
  lastSeq: number;
}

export type WebNavigationAction =
  | { type: "bridge"; event: BridgeEvent }
  | { type: "user-navigate"; url: string }
  | { type: "user-back" }
  | { type: "user-forward" }
  | { type: "reset"; url: string };

export function createWebNavigationState(url: string): WebNavigationState {
  return {
    displayUrl: url,
    title: "",
    canGoBack: false,
    canGoForward: false,
    bridgeReady: false,
    stack: [url],
    index: 0,
    lastDocId: null,
    lastSeq: 0,
  };
}

function movedTo(state: WebNavigationState, index: number): WebNavigationState {
  return {
    ...state,
    displayUrl: state.stack[index] ?? state.displayUrl,
    index,
    canGoBack: index > 0,
    canGoForward: index < state.stack.length - 1,
  };
}

export function webNavigationReducer(
  state: WebNavigationState,
  action: WebNavigationAction,
): WebNavigationState {
  switch (action.type) {
    case "reset":
      return createWebNavigationState(action.url);

    case "user-navigate": {
      const stack = [...state.stack.slice(0, state.index + 1), action.url];
      return movedTo({ ...state, stack }, stack.length - 1);
    }

    case "user-back":
      return state.index > 0 ? movedTo(state, state.index - 1) : state;

    case "user-forward":
      return state.index < state.stack.length - 1 ? movedTo(state, state.index + 1) : state;

    case "bridge": {
      const event = action.event;
      if (event.type === "ready") {
        return { ...state, bridgeReady: true, lastDocId: event.docId, lastSeq: 0 };
      }
      if (event.type !== "navigation") return state;

      // A new document restarts seq at 1, so only compare within one document.
      const sameDocument = state.lastDocId === event.docId;
      if (sameDocument && event.seq <= state.lastSeq) return state;

      return {
        ...state,
        bridgeReady: true,
        displayUrl: event.url,
        title: event.title,
        canGoBack: event.canGoBack,
        canGoForward: event.canGoForward,
        lastDocId: event.docId,
        lastSeq: event.seq,
      };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/app/src/desktop/browser/pane/web-navigation.test.ts --bail=1`
Expected: PASS, 9 tests.

- [ ] **Step 5: Format, lint, typecheck**

Run: `npm run format && npm run lint && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/desktop/browser/pane/web-navigation.ts packages/app/src/desktop/browser/pane/web-navigation.test.ts
git commit -m "feat(app/browser): add web browser navigation reducer"
```

---

### Task 8: Preview URL round-tripping

The URL bar must show `localhost:3000/path` while the iframe is on `3000.preview.example.com/path`. `resolveWebBrowserSrc` already goes one way; this adds the inverse, so a bridge-reported URL can be displayed.

**Files:**

- Modify: `packages/app/src/desktop/browser/pane/web-preview-url.ts`
- Modify: `packages/app/src/desktop/browser/pane/web-preview-url.test.ts`

**Interfaces:**

- Consumes: `buildBrowserPreviewUrl` (existing, from `workspace-browser-preview`).
- Produces: `toDisplayUrl(input: {url: string; template: string | null; originalUrl: string}): string`

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/app/src/desktop/browser/pane/web-preview-url.test.ts
import { toDisplayUrl } from "./web-preview-url";

const TEMPLATE = "https://{port}.preview.example.com";

describe("toDisplayUrl", () => {
  it("maps a preview origin back to localhost", () => {
    expect(
      toDisplayUrl({
        url: "https://3000.preview.example.com/about?q=1#x",
        template: TEMPLATE,
        originalUrl: "http://localhost:3000/",
      }),
    ).toBe("http://localhost:3000/about?q=1#x");
  });

  it("keeps the loopback hostname the user typed", () => {
    expect(
      toDisplayUrl({
        url: "https://3000.preview.example.com/a",
        template: TEMPLATE,
        originalUrl: "http://127.0.0.1:3000/",
      }),
    ).toBe("http://127.0.0.1:3000/a");
  });

  it("passes a non-preview url through untouched", () => {
    expect(
      toDisplayUrl({
        url: "https://example.com/page",
        template: TEMPLATE,
        originalUrl: "https://example.com/",
      }),
    ).toBe("https://example.com/page");
  });

  it("passes through when there is no template", () => {
    expect(
      toDisplayUrl({
        url: "https://a.example/x",
        template: null,
        originalUrl: "https://a.example",
      }),
    ).toBe("https://a.example/x");
  });

  it("round-trips with resolveWebBrowserSrc", () => {
    const original = "http://localhost:5173/nested/path?a=b";
    const resolved = resolveWebBrowserSrc({ url: original, template: TEMPLATE });
    expect(resolved.kind).toBe("preview");
    if (resolved.kind !== "preview") return;
    expect(toDisplayUrl({ url: resolved.src, template: TEMPLATE, originalUrl: original })).toBe(
      original,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/app/src/desktop/browser/pane/web-preview-url.test.ts --bail=1`
Expected: FAIL — `toDisplayUrl is not exported`.

- [ ] **Step 3: Write minimal implementation**

Append to `web-preview-url.ts`:

```ts
// The inverse of resolveWebBrowserSrc's preview branch. The bridge reports the
// preview origin, but the address bar must keep showing the loopback URL the
// user asked for — the preview origin is transport, never something to display.
export function toDisplayUrl(input: {
  url: string;
  template: string | null;
  originalUrl: string;
}): string {
  if (!input.template) return input.url;

  let reported: URL;
  let original: URL;
  try {
    reported = new URL(input.url);
    original = new URL(input.originalUrl);
  } catch {
    return input.url;
  }

  const port = Number(original.port || (original.protocol === "https:" ? 443 : 80));
  let previewBase: URL;
  try {
    previewBase = new URL(buildBrowserPreviewUrl(input.template, port));
  } catch {
    return input.url;
  }
  if (reported.host !== previewBase.host) return input.url;

  original.pathname = reported.pathname;
  original.search = reported.search;
  original.hash = reported.hash;
  return original.toString();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/app/src/desktop/browser/pane/web-preview-url.test.ts --bail=1`
Expected: PASS, existing cases plus 5 new.

- [ ] **Step 5: Format, lint, typecheck**

Run: `npm run format && npm run lint && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/desktop/browser/pane/web-preview-url.ts packages/app/src/desktop/browser/pane/web-preview-url.test.ts
git commit -m "feat(app/browser): map preview origins back to loopback for display"
```

---

### Task 9: The sticky notice and its strings

**Files:**

- Create: `packages/app/src/desktop/browser/pane/web-notice.tsx`
- Modify: all nine of `packages/app/src/i18n/resources/{en,ar,es,fr,ja,ko,pt-BR,ru,zh-CN}.ts`

**Interfaces:**

- Consumes: `useTranslation`, `useUnistyles` (existing patterns in `index.web.tsx`).
- Produces: `WebBrowserNotice: () => ReactElement`

New key `workspace.browser.iframeNotice`, added inside the existing `workspace.browser` object next to `controls` and `devices`.

- [ ] **Step 1: Add the string to every locale**

English:

```ts
iframeNotice:
  "This page is running inside an iframe, so some sites refuse to load and devtools aren't available. Use the desktop app for a full browser.",
```

Translate for `ar, es, fr, ja, ko, pt-BR, ru, zh-CN`, matching each file's existing tone for the neighbouring `workspace.browser` strings.

- [ ] **Step 2: Verify every locale has the key**

Run:

```bash
for f in packages/app/src/i18n/resources/{en,ar,es,fr,ja,ko,pt-BR,ru,zh-CN}.ts; do
  grep -q "iframeNotice" "$f" || echo "MISSING: $f"
done
```

Expected: no output.

- [ ] **Step 3: Write the component**

```tsx
// packages/app/src/desktop/browser/pane/web-notice.tsx
import type { ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

// Shown while the tab is on a URL the daemon does not proxy. Not dismissible:
// it describes a condition that holds for as long as the tab stays there, and
// it removes itself when navigation reaches a proxied URL.
export function WebBrowserNotice(): ReactElement {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  return (
    <View
      style={[
        styles.notice,
        { backgroundColor: theme.colors.muted, borderBottomColor: theme.colors.border },
      ]}
    >
      <Text
        numberOfLines={1}
        style={[styles.text, { color: theme.colors.foregroundMuted }]}
        accessibilityRole="alert"
      >
        {t("workspace.browser.iframeNotice")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  notice: {
    width: "100%",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  text: {
    fontSize: theme.fontSize.xs,
  },
}));
```

- [ ] **Step 4: Verify it compiles**

Run: `npm run format && npm run lint && npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/desktop/browser/pane/web-notice.tsx packages/app/src/i18n/resources/
git commit -m "feat(app/browser): add iframe limitation notice for direct URLs"
```

---

### Task 10: Toolbar and annotation composer

**Files:**

- Create: `packages/app/src/desktop/browser/pane/web-toolbar.tsx`
- Create: `packages/app/src/desktop/browser/pane/web-annotation-composer.tsx`

**Interfaces:**

- Consumes: `WebNavigationState` (Task 7); `BROWSER_DEVICE_SIZE_PRESETS`, `formatBrowserDevicePresetLabel`, `getBrowserDevicePreset` (`device-presets.ts`); `BrowserViewport`, `createFixedBrowserViewport`, `RESPONSIVE_BROWSER_VIEWPORT` (`store/state.ts`); `EditingTextInput`, `EditingTextInputHandle` (`@/components/ui/text-input`); `BrowserElementAnnotation` (`browser-element-attachment.ts`).
- Produces:
  - `WebBrowserToolbar(props: {state: WebNavigationState; bridgeAvailable: boolean; isSelecting: boolean; isErudaOpen: boolean; viewport: BrowserViewport; onSubmitUrl(url: string): void; onBack(): void; onForward(): void; onReload(): void; onToggleEruda(): void; onToggleSelect(): void; onChangeViewport(viewport: BrowserViewport): void}): ReactElement`
  - `WebAnnotationComposer(props: {onSubmit(annotation: BrowserElementAnnotation): void; onCancel(): void}): ReactElement`

Reuse existing i18n keys — `workspace.browser.controls.{back,forward,refresh,browserUrl,enterUrl,openDevTools,annotateElement,cancelSelector}`, `workspace.browser.annotate.{title,placeholder,submit,cancel}`, `workspace.browser.devices.{label,responsive}`. No new keys.

Bridge-dependent controls — back, forward, devtools, select — render with `disabled={!props.bridgeAvailable}` so a direct URL or an old daemon shows an inert control rather than one that silently does nothing. Reload stays enabled: the pane remounts the iframe when there is no bridge.

- [ ] **Step 1: Write the components**

`WebBrowserToolbar` renders one row: back, forward, reload, `EditingTextInput` keyed on `state.displayUrl` (so the field resyncs when the bridge reports a new URL), a device-size dropdown built from `BROWSER_DEVICE_SIZE_PRESETS`, the eruda toggle, and the select toggle. Mirror the styles already in `index.web.tsx`'s `addressBar` and `urlInput`.

`WebAnnotationComposer` renders a text field plus Attach and Cancel buttons, calling `onSubmit({comment})`.

- [ ] **Step 2: Verify they compile**

Run: `npm run format && npm run lint && npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/desktop/browser/pane/web-toolbar.tsx packages/app/src/desktop/browser/pane/web-annotation-composer.tsx
git commit -m "feat(app/browser): add web browser toolbar and annotation composer"
```

---

### Task 11: Assemble the pane

**Files:**

- Modify: `packages/app/src/desktop/browser/pane/index.web.tsx` (full rewrite)

**Interfaces:**

- Consumes: everything from Tasks 6-10, plus `buildBrowserElementAttachment` and `buildBrowserAttachmentScopeKey` (`browser-element-attachment.ts`), `useWorkspaceAttachmentsStore`'s `addWorkspaceAttachment` (`@/attachments/workspace-attachments-store`), `useBrowserStore`, `setBrowserViewport` and `normalizeWorkspaceBrowserUrl` (`store`), `useBrowserPreviewTemplate` (`workspace-browser-preview`).
- Produces: `BrowserPane` with its existing props unchanged.

Behaviour:

1. Resolve `resolveWebBrowserSrc({url, template})` as today. `no-template` and unsupported-protocol states are unchanged.
2. `useReducer(webNavigationReducer, ..., createWebNavigationState)`. **Two distinct paths, and conflating them breaks one of them:**
   - An **address-bar submit** dispatches `{type:"user-navigate"}`. It must not dispatch `reset` — `reset` rebuilds from the factory, so routing URL-bar moves through it leaves `stack` permanently `[url]` at index 0, `canGoBack` permanently false, and the entire parent-side history half of the reducer unreachable. That would silently delete the "back/forward across URL-bar navigations" behaviour the spec's degradation table promises for direct URLs.
   - An **externally-driven tab-url change** — initial mount, tab switch, an `open-url` arriving from chat — dispatches `{type:"reset"}`, because the parent's history genuinely does not carry over.
3. When `resolved.kind === "preview"`, create a bridge with `origin = new URL(resolved.src).origin` and `getFrame = () => iframeRef.current?.contentWindow ?? null`. Dispose on unmount and on src change.
4. Map bridge events: `navigation` → dispatch, and `updateBrowser(browserId, {url: displayed, title, canGoBack, canGoForward})` so the tab title follows; `selection` → set pending selection, opening the annotation composer; `select-cancelled` → clear selecting.
5. `displayUrl` shown in the toolbar is `toDisplayUrl({url: state.displayUrl, template, originalUrl: url})`.
6. Back/forward/reload send bridge commands when `state.bridgeReady`, otherwise dispatch the parent-stack action and bump `reloadKey`. **The pane does carry this one branch** — an earlier draft of this plan claimed the reducer left it with none, which was wrong. There is no bridge-side back/forward _action_ in the reducer, so dispatching `user-back` while a bridge is live walks the parent stack instead of the page's real history: with no pre-bridge URL-bar moves that stack is `[START]` at index 0, so the dispatch hits the bounds guard and returns state unchanged — a back button lit by the bridge's own `canGoBack` that silently does nothing. `bridgeReady` is the discriminator.
7. URL submit: `normalizeWorkspaceBrowserUrl`, then dispatch `{type:"user-navigate"}` **and** `updateBrowser(browserId, {url})`. Same-URL submit reloads.

   **These two steps collide unless the pane can tell its own submit apart from an external change**, and the collision silently undoes step 2. `updateBrowser` changes the tab's `url`, which fires the very effect step 2 routes to `reset` — so a naive wiring dispatches `user-navigate`, then `reset`, and `reset` wins. The parent stack is then permanently `[url]` at index 0 and the direct-URL back/forward behaviour is gone, which is exactly what step 2 exists to prevent.

   Hold the URL the pane itself last submitted in a ref, and have the reset effect skip when the incoming tab `url` equals it. An external change — tab switch, restore, an `open-url` from chat — will not match, and still resets.

8. Navigating without a bridge **remounts** the iframe via `reloadKey` — assigning `src` would push onto the top-level history and hijack the app's own back button.
9. `resolved.kind === "direct"` renders `<WebBrowserNotice />` between the toolbar and the iframe.
10. Viewport: `browser.viewport` sizes the iframe (`mode === "fixed"` → explicit width/height, centred; `responsive` → flex), and the toolbar's dropdown calls `setBrowserViewport`.
11. Annotation submit builds the attachment and appends it:

```tsx
const scopeKey = buildBrowserAttachmentScopeKey({ cwd, serverId, workspaceId });
if (scopeKey && pendingSelection) {
  addWorkspaceAttachment({
    scopeKey,
    attachment: {
      kind: "browser_element",
      attachment: buildBrowserElementAttachment(pendingSelection, annotation),
    },
  });
}
```

Use the store's `addWorkspaceAttachment` (`workspace-attachments-store.ts:140`), which appends and dedupes internally. `index.electron.tsx` predates it and hand-rolls the same thing with `setWorkspaceAttachments`; do not copy that.

No screenshot argument: `captureElement` is an Electron main-process bridge with no iframe equivalent, so web attachments are text-only.

- [ ] **Step 1: Rewrite the pane**

- [ ] **Step 2: Verify existing tests still pass**

Run: `npx vitest run packages/app/src/desktop/browser/pane/web-preview-url.test.ts packages/app/src/desktop/browser/pane/web-bridge.test.ts packages/app/src/desktop/browser/pane/web-navigation.test.ts packages/app/src/desktop/browser/workspace-browser-availability.test.ts packages/app/src/desktop/browser/workspace-browser-preview.test.ts --bail=1`
Expected: PASS.

- [ ] **Step 3: Format, lint, typecheck**

Run: `npm run format && npm run lint && npm run typecheck`

- [ ] **Step 4: Manual verification**

Start the dev daemon with a preview template and a dev server on 3000:

```bash
PASEO_BROWSER_PREVIEW_URL_TEMPLATE="http://{port}.preview.localtest.me:6767" npm run dev
```

In the web app, open a Browser tab, type `localhost:3000`, and confirm: the URL bar follows a client-side route change; back and forward work; the devtools button opens eruda; clicking select attaches an element to the composer; typing `example.com` shows the notice and hides the bridge controls.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/desktop/browser/pane/index.web.tsx
git commit -m "feat(app/browser): full browser chrome for the web build pane"
```

---

### Task 12: Docs and fork decision

**Files:**

- Modify: `docs/browser-localhost-routing.md`
- Modify: `docs/fork-decisions.md`

- [ ] **Step 1: Rewrite the Web build section**

Under `## Web build`, replace `There is no Service Worker and no injected script; the daemon does the proxying` — it is now false. Describe injection: `<head>` insertion, the 64 KiB scan window, decompression, meta-CSP stripping, and that the bridge announces itself rather than being advertised on `server_info`.

- [ ] **Step 2: Delete the stale limitation**

Remove the `**The address bar does not follow in-page navigation.**` bullet from `### Known limitations` entirely. Do not leave a corrected paragraph next to it — that is how a doc becomes a pile of paragraphs in discovery order.

Add, in its place, the limits that are now true: eruda comes from jsdelivr, so devtools need internet from the client; a direct URL gets no bridge, and back/forward there covers URL-bar navigations only.

- [ ] **Step 3: Add the fork decision**

````markdown
## browser-web-devtools-bridge

**daemon injects a devtools bridge into proxied preview HTML**

browser-preview rewrites text/html responses to insert a navigation, eruda and element-selector bridge into <head>; the web Browser pane drives it over postMessage for history, URL sync, devtools and element attachments

```bash
npx vitest run packages/server/src/server/browser-preview/html-injection.test.ts packages/server/src/server/browser-preview/inject/index.test.ts packages/app/src/desktop/browser/pane/web-bridge.test.ts packages/app/src/desktop/browser/pane/web-navigation.test.ts --bail=1
grep -q "createHtmlInjectionStream" packages/server/src/server/browser-preview/index.ts
```
````

````

- [ ] **Step 4: Verify the fork decision proof passes**

Run: `npm run fork:verify`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add docs/browser-localhost-routing.md docs/fork-decisions.md docs/superpowers/
git commit -m "docs(browser): document the web devtools bridge"
````

---

## Self-Review

**Spec coverage.** URL bar follows in-page nav → Tasks 3, 6, 7, 8, 11. Back/forward/reload → 3, 7, 10, 11. eruda → 4, 10, 11. Select-as-context → 4, 6, 10, 11. Any URL loads → existing `direct` path, preserved in 11. Notice → 9, 11. Viewport → 10, 11. Streaming → 2. Decompression → 5. Meta CSP → 1, 2. No protocol change → constraint, honoured throughout. Docs → 12. Every spec section maps to a task.

**Type consistency.** `BridgeEvent` and `BridgeCommand` are defined in Task 6 and consumed under those names in 7, 10 and 11. `WebNavigationState` is defined in 7 and consumed in 10 and 11. `toDisplayUrl` is defined in 8 and consumed in 11. The selection payload schema in Task 6 matches `BrowserElementAttachment` in `packages/app/src/attachments/types.ts:25-55` field for field, so `buildBrowserElementAttachment` accepts it without a shim.

**Known gap, deliberate:** eruda actually loading from jsdelivr and rendering is not unit-tested — it needs a real network and a real browser. Task 11 Step 4 covers it as manual QA, per the evidence bar in [docs/qa.md](../../qa.md).
