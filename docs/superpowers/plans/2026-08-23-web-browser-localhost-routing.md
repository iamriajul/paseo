# Web build Browser localhost routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the in-app Browser work in the web build by having each daemon publish an ordinary web address per loopback port and reverse-proxy it.

**Architecture:** A daemon configured with a URL template such as `https://{port}--daemon-1.studio.example.com` matches inbound `Host` headers against that template, and proxies to `127.0.0.1:<port>` with `Host: localhost:<port>` so the dev server sees its normal origin. New code lives in a fork-owned `browser-preview/` directory; the only upstream edits are two mount lines, one config resolver, one schema key, one protocol field, and the web pane.

**Tech Stack:** TypeScript, Node `node:http`/`node:net`, Express, Zod, Vitest, React Native / Expo (app), i18next.

**Spec:** `docs/superpowers/specs/2026-08-23-web-browser-localhost-routing-design.md`

## Global Constraints

- **v1 is direct-connection only.** Relay hosts advertise no template and show an unavailable state. Do not build a Service Worker, a tunnel transport, or any fallback path.
- **Do not extract, move, or restructure anything inside `packages/server/src/server/service-proxy.ts`.** This is a fork that merges upstream every release; relocating upstream code conflicts on every sync. Adding `export` to an existing declaration is allowed and expected.
- **Exactly two helpers are imported from `service-proxy.ts`:** `normalizeHostHeader` (line 94) and `stripHopByHopHeaders` (line 247). Add `export` to each. Do **not** import `capDnsLabel` — it truncates, and validation must reject.
- **Never run the full test suite.** Run only the file under test: `npx vitest run <file> --bail=1`. Never `npm run test`.
- **Run `npm run typecheck` and `npm run lint` after every change.** Run `npm run format` before committing; never hand-format.
- **Protocol fields are optional and additive.** Never narrow, never remove, never require. No `.transform()`, `.catch()` or `.preprocess()` in wire schemas.
- **Capability is gated on the presence of `browserPreview.urlTemplate`, not on a `features.*` boolean.** Do not add `features.browserPreview`.
- **i18n keys must exist in all 9 locales** (`ar, en, es, fr, ja, ko, pt-BR, ru, zh-CN`). `packages/app/src/i18n/resources.test.ts:109-116` asserts exact key parity and will fail otherwise.
- **Template placeholder is `{port}`, exactly once, inside the hostname.** A placeholder in the path is rejected at startup.

---

### Task 1: Preview URL template parsing and building

Pure module. No I/O, no Express. Turns an operator-supplied template into something that can build a URL from a port and recover a port from a `Host` header.

**Files:**

- Create: `packages/server/src/server/browser-preview/url-template.ts`
- Test: `packages/server/src/server/browser-preview/url-template.test.ts`
- Modify: `packages/server/src/server/service-proxy.ts:94` (add `export` to `normalizeHostHeader`)

**Interfaces:**

- Consumes: `normalizeHostHeader` from `./service-proxy.js`.
- Produces:
  - `interface BrowserPreviewTemplate { readonly raw: string; buildUrl(port: number): string; matchHost(hostHeader: string | undefined): number | null; }`
  - `function parseBrowserPreviewTemplate(raw: string): BrowserPreviewTemplate` — throws `Error` with a message starting `Invalid PASEO_BROWSER_PREVIEW_URL_TEMPLATE:` on any validation failure.

- [ ] **Step 1: Add the export to `service-proxy.ts`**

Change line 94 from `function normalizeHostHeader(` to `export function normalizeHostHeader(`. Change nothing else in that file.

- [ ] **Step 2: Write the failing test**

Create `packages/server/src/server/browser-preview/url-template.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { parseBrowserPreviewTemplate } from "./url-template.js";

describe("parseBrowserPreviewTemplate", () => {
  it("builds a URL for a port using a dedicated wildcard", () => {
    const t = parseBrowserPreviewTemplate("https://{port}.preview.example.com");
    expect(t.buildUrl(3000)).toBe("https://3000.preview.example.com");
  });

  it("builds a URL for a port in a shared orchestrated wildcard", () => {
    const t = parseBrowserPreviewTemplate("https://{port}--daemon-1.studio.example.com");
    expect(t.buildUrl(5173)).toBe("https://5173--daemon-1.studio.example.com");
  });

  it("preserves an explicit port on the template origin", () => {
    const t = parseBrowserPreviewTemplate("https://{port}.preview.example.com:8443");
    expect(t.buildUrl(3000)).toBe("https://3000.preview.example.com:8443");
  });

  it("recovers the port from a matching Host header", () => {
    const t = parseBrowserPreviewTemplate("https://{port}--daemon-1.studio.example.com");
    expect(t.matchHost("3000--daemon-1.studio.example.com")).toBe(3000);
  });

  it("recovers the port when the Host header carries a port and mixed case", () => {
    const t = parseBrowserPreviewTemplate("https://{port}.preview.example.com");
    expect(t.matchHost("3000.PREVIEW.example.com:443")).toBe(3000);
  });

  it("returns null for hosts that do not match the template", () => {
    const t = parseBrowserPreviewTemplate("https://{port}--daemon-1.studio.example.com");
    expect(t.matchHost("daemon-1.studio.example.com")).toBeNull();
    expect(t.matchHost("3000--daemon-2.studio.example.com")).toBeNull();
    expect(t.matchHost("dev--miniweb.studio.example.com")).toBeNull();
    expect(t.matchHost("30x0--daemon-1.studio.example.com")).toBeNull();
    expect(t.matchHost(undefined)).toBeNull();
  });

  it("rejects ports outside 1..65535", () => {
    const t = parseBrowserPreviewTemplate("https://{port}.preview.example.com");
    expect(t.matchHost("0.preview.example.com")).toBeNull();
    expect(t.matchHost("65536.preview.example.com")).toBeNull();
    expect(t.matchHost("099.preview.example.com")).toBeNull();
  });

  it("rejects a template with no placeholder or more than one", () => {
    expect(() => parseBrowserPreviewTemplate("https://preview.example.com")).toThrow(
      /Invalid PASEO_BROWSER_PREVIEW_URL_TEMPLATE/,
    );
    expect(() => parseBrowserPreviewTemplate("https://{port}.{port}.example.com")).toThrow(
      /Invalid PASEO_BROWSER_PREVIEW_URL_TEMPLATE/,
    );
  });

  it("rejects a placeholder outside the hostname", () => {
    expect(() => parseBrowserPreviewTemplate("https://preview.example.com/{port}")).toThrow(
      /must appear in the hostname/,
    );
  });

  it("rejects a non-http scheme and an unparseable template", () => {
    expect(() => parseBrowserPreviewTemplate("ftp://{port}.preview.example.com")).toThrow(
      /Invalid PASEO_BROWSER_PREVIEW_URL_TEMPLATE/,
    );
    expect(() => parseBrowserPreviewTemplate("not a url {port}")).toThrow(
      /Invalid PASEO_BROWSER_PREVIEW_URL_TEMPLATE/,
    );
  });

  it("supports a placeholder that is not at the start of its label", () => {
    const t = parseBrowserPreviewTemplate("https://preview-{port}.example.com");
    expect(t.buildUrl(8080)).toBe("https://preview-8080.example.com");
    expect(t.matchHost("preview-8080.example.com")).toBe(8080);
    expect(t.matchHost("preview-.example.com")).toBeNull();
  });

  it("rejects a label that exceeds 63 characters with a five-digit port", () => {
    const long = "a".repeat(60);
    expect(() => parseBrowserPreviewTemplate(`https://{port}--${long}.example.com`)).toThrow(
      /63 characters/,
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/server/src/server/browser-preview/url-template.test.ts --bail=1`
Expected: FAIL — cannot resolve `./url-template.js`.

- [ ] **Step 4: Write the implementation**

Create `packages/server/src/server/browser-preview/url-template.ts`:

```typescript
import { normalizeHostHeader } from "../service-proxy.js";

const PLACEHOLDER = "{port}";
const MAX_DNS_LABEL_LENGTH = 63;
// Longest decimal port is 65535; used to size-check the label at config time.
const WIDEST_PORT = "65535";

export interface BrowserPreviewTemplate {
  readonly raw: string;
  buildUrl(port: number): string;
  matchHost(hostHeader: string | undefined): number | null;
}

function invalid(detail: string, raw: string): Error {
  return new Error(`Invalid PASEO_BROWSER_PREVIEW_URL_TEMPLATE: ${detail} (${raw})`);
}

export function parseBrowserPreviewTemplate(raw: string): BrowserPreviewTemplate {
  const trimmed = raw.trim();
  const occurrences = trimmed.split(PLACEHOLDER).length - 1;
  if (occurrences !== 1) {
    throw invalid(`template must contain ${PLACEHOLDER} exactly once`, raw);
  }

  // Substitute a probe port so the result is a parseable URL. The probe is the
  // widest port so the label length check covers the worst case.
  const probe = trimmed.replace(PLACEHOLDER, WIDEST_PORT);
  let probeUrl: URL;
  try {
    probeUrl = new URL(probe);
  } catch {
    throw invalid("template is not an absolute URL once the port is substituted", raw);
  }

  if (probeUrl.protocol !== "http:" && probeUrl.protocol !== "https:") {
    throw invalid("template must use http or https", raw);
  }
  if (probeUrl.pathname !== "/" || probeUrl.search !== "" || probeUrl.hash !== "") {
    throw invalid("template must not carry a path, query or fragment", raw);
  }
  if (probeUrl.username !== "" || probeUrl.password !== "") {
    throw invalid("template must not carry credentials", raw);
  }

  // The placeholder must be inside the hostname. A path-positioned placeholder
  // would lose the port on every root-absolute subresource request.
  const placeholderIndex = trimmed.indexOf(PLACEHOLDER);
  const schemeEnd = trimmed.indexOf("://");
  const authorityStart = schemeEnd === -1 ? 0 : schemeEnd + 3;
  const authorityEnd = (() => {
    const rest = trimmed.slice(authorityStart);
    const cut = rest.search(/[/?#]/);
    return cut === -1 ? trimmed.length : authorityStart + cut;
  })();
  if (placeholderIndex < authorityStart || placeholderIndex >= authorityEnd) {
    throw invalid(`${PLACEHOLDER} must appear in the hostname`, raw);
  }

  // Split the template's own authority around the placeholder rather than the
  // probe's: a hostname may legitimately contain "65535" elsewhere, and indexOf
  // would then split in the wrong place. Lowercased so Host matching compares
  // like for like, and the :port suffix dropped so matching ignores it.
  const authority = trimmed.slice(authorityStart, authorityEnd);
  const authorityHost = authority.replace(/:\d+$/, "");
  const [rawPrefix = "", rawSuffix = ""] = authorityHost.split(PLACEHOLDER);
  const hostPrefix = rawPrefix.toLowerCase();
  const hostSuffix = rawSuffix.toLowerCase();

  // The placeholder may sit in any label and anywhere within it, so measure the
  // label that actually contains it rather than assuming it is the first.
  const labelLength =
    (hostPrefix.split(".").pop() ?? "").length +
    WIDEST_PORT.length +
    (hostSuffix.split(".")[0] ?? "").length;
  if (labelLength > MAX_DNS_LABEL_LENGTH) {
    throw invalid(
      `the label containing ${PLACEHOLDER} exceeds ${MAX_DNS_LABEL_LENGTH} characters with a five-digit port`,
      raw,
    );
  }

  return {
    raw: trimmed,
    buildUrl(port: number): string {
      return trimmed.replace(PLACEHOLDER, String(port));
    },
    matchHost(hostHeader: string | undefined): number | null {
      if (!hostHeader) return null;
      const hostname = normalizeHostHeader(hostHeader);
      if (!hostname.startsWith(hostPrefix) || !hostname.endsWith(hostSuffix)) return null;
      const middle = hostname.slice(hostPrefix.length, hostname.length - hostSuffix.length);
      if (!/^[1-9]\d*$/.test(middle)) return null;
      const port = Number(middle);
      return port >= 1 && port <= 65535 ? port : null;
    },
  };
}
```

If `normalizeHostHeader` does not lowercase or does not strip the port, adjust `matchHost` to do so explicitly rather than changing `normalizeHostHeader`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/server/src/server/browser-preview/url-template.test.ts --bail=1`
Expected: PASS, 12 tests.

- [ ] **Step 6: Typecheck, lint, format**

```bash
npm run typecheck
npm run lint -- packages/server/src/server/browser-preview/url-template.ts
npm run format
```

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/server/browser-preview/ packages/server/src/server/service-proxy.ts
git commit -m "feat(server): parse and match browser preview URL templates"
```

---

### Task 2: Response header policy

Pure functions over header maps. Separated from socket work so they are testable without a server.

**Files:**

- Create: `packages/server/src/server/browser-preview/response-headers.ts`
- Test: `packages/server/src/server/browser-preview/response-headers.test.ts`

**Interfaces:**

- Consumes: `BrowserPreviewTemplate` from Task 1.
- Produces: `function transformPreviewResponseHeaders(options: TransformPreviewResponseHeadersOptions): NodeJS.Dict<string | string[]>`, where the options interface is internal (no external caller imports it). Single named object param per `packages/server/CLAUDE.md` ("Object parameters", and "Named types — no complex inline types in public signatures").

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/server/browser-preview/response-headers.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { parseBrowserPreviewTemplate } from "./url-template.js";
import { transformPreviewResponseHeaders } from "./response-headers.js";

const template = parseBrowserPreviewTemplate("https://{port}--daemon-1.studio.example.com");
const run = (headers: NodeJS.Dict<string | string[]>, targetPort = 4000) =>
  transformPreviewResponseHeaders({ headers, targetPort, template });

describe("transformPreviewResponseHeaders", () => {
  it("strips framing and policy headers so the page can be embedded", () => {
    const out = run({
      "content-security-policy": "frame-ancestors 'none'",
      "content-security-policy-report-only": "default-src 'self'",
      "x-frame-options": "DENY",
      "content-type": "text/html",
    });
    expect(out["content-security-policy"]).toBeUndefined();
    expect(out["content-security-policy-report-only"]).toBeUndefined();
    expect(out["x-frame-options"]).toBeUndefined();
    expect(out["content-type"]).toBe("text/html");
  });

  it("rewrites an absolute loopback Location on the target port", () => {
    const out = run({ location: "http://localhost:4000/generate?from=auth#done" });
    expect(out.location).toBe("https://4000--daemon-1.studio.example.com/generate?from=auth#done");
  });

  it("rewrites 127.0.0.1 and [::1] forms on the target port", () => {
    expect(run({ location: "http://127.0.0.1:4000/x" }).location).toBe(
      "https://4000--daemon-1.studio.example.com/x",
    );
    expect(run({ location: "http://[::1]:4000/x" }).location).toBe(
      "https://4000--daemon-1.studio.example.com/x",
    );
  });

  it("rewrites content-location the same way", () => {
    expect(run({ "content-location": "http://localhost:4000/y" })["content-location"]).toBe(
      "https://4000--daemon-1.studio.example.com/y",
    );
  });

  it("rewrites the URL inside a refresh header and keeps the delay", () => {
    expect(run({ refresh: "0; url=http://localhost:4000/z" }).refresh).toBe(
      "0; url=https://4000--daemon-1.studio.example.com/z",
    );
  });

  it("leaves relative redirects untouched so the browser keeps the proxy origin", () => {
    expect(run({ location: "/about" }).location).toBe("/about");
    expect(run({ location: "?page=2" }).location).toBe("?page=2");
  });

  it("leaves loopback redirects on a different port untouched", () => {
    expect(run({ location: "http://localhost:9999/x" }).location).toBe("http://localhost:9999/x");
  });

  it("leaves non-loopback redirects untouched", () => {
    expect(run({ location: "https://example.com/x" }).location).toBe("https://example.com/x");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/server/src/server/browser-preview/response-headers.test.ts --bail=1`
Expected: FAIL — cannot resolve `./response-headers.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/server/src/server/browser-preview/response-headers.ts`:

```typescript
import type { BrowserPreviewTemplate } from "./url-template.js";

// Removed so the preview can be embedded in an iframe on the proxy origin.
const STRIPPED_RESPONSE_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
]);

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

interface RewriteUrlOptions {
  targetPort: number;
  template: BrowserPreviewTemplate;
}

interface TransformPreviewResponseHeadersOptions extends RewriteUrlOptions {
  headers: NodeJS.Dict<string | string[]>;
}

// URL.port is "" when the port equals the scheme's default, so a dev server on
// port 80 emitting `Location: http://localhost/x` would never match targetPort.
function effectivePort(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function rewriteAbsoluteUrl(value: string, options: RewriteUrlOptions): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return value; // relative or malformed: leave for the browser to resolve
  }
  // URL keeps IPv6 hostnames bracketed; compare unbracketed.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK_HOSTNAMES.has(hostname)) return value;
  if (effectivePort(parsed) !== options.targetPort) return value;

  const base = new URL(options.template.buildUrl(options.targetPort));
  parsed.protocol = base.protocol;
  parsed.hostname = base.hostname;
  parsed.port = base.port;
  return parsed.toString();
}

function rewriteRefresh(value: string, options: RewriteUrlOptions): string {
  // Stop the URL capture at the next `;` and re-append the remainder verbatim.
  // A greedy capture swallows trailing directives into the path, and because
  // `;` is legal in a path `new URL()` accepts it — silent corruption.
  const match = /^(\s*[^;]*;\s*url=)([^;]*)(.*)$/i.exec(value);
  if (!match) return value;
  const [, head, target, tail] = match;
  const unquoted = target.trim().replace(/^["']|["']$/g, "");
  const rewritten = rewriteAbsoluteUrl(unquoted, options);
  return rewritten === unquoted ? value : `${head}${rewritten}${tail}`;
}

export function transformPreviewResponseHeaders(
  options: TransformPreviewResponseHeadersOptions,
): NodeJS.Dict<string | string[]> {
  const { headers, ...urlOptions } = options;
  const out: NodeJS.Dict<string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(lower)) continue;
    if (value === undefined) continue;

    if (lower === "location" || lower === "content-location") {
      out[name] = Array.isArray(value)
        ? value.map((v) => rewriteAbsoluteUrl(v, urlOptions))
        : rewriteAbsoluteUrl(value, urlOptions);
      continue;
    }
    if (lower === "refresh") {
      out[name] = Array.isArray(value)
        ? value.map((v) => rewriteRefresh(v, urlOptions))
        : rewriteRefresh(value, urlOptions);
      continue;
    }
    out[name] = value;
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/src/server/browser-preview/response-headers.test.ts --bail=1`
Expected: PASS, 10 tests — the 8 above, plus one for a `refresh` value carrying a trailing `;directive` after the URL, and one for a default-port loopback `Location` (`http://localhost/x` with targetPort 80) paired with a case that must still pass through.

- [ ] **Step 5: Typecheck, lint, format, commit**

```bash
npm run typecheck
npm run lint -- packages/server/src/server/browser-preview/response-headers.ts
npm run format
git add packages/server/src/server/browser-preview/
git commit -m "feat(server): strip framing headers and rewrite redirects for browser preview"
```

---

### Task 3: Preview subsystem — middleware and upgrade handler

Wires the template and header policy to real sockets. Forwarding is owned rather than shared, because `proxyHttpRequest` (`service-proxy.ts:318`) bakes in the service policy: it sets `X-Forwarded-*` via `buildForwardedHeaders` (`:273`) and passes `Host` through, and preview needs the inverse of both.

**Files:**

- Create: `packages/server/src/server/browser-preview/index.ts`
- Test: `packages/server/src/server/browser-preview/index.test.ts`
- Modify: `packages/server/src/server/service-proxy.ts:247` (add `export` to `stripHopByHopHeaders`)

**Interfaces:**

- Consumes: `parseBrowserPreviewTemplate`, `BrowserPreviewTemplate` (Task 1); `transformPreviewResponseHeaders` (Task 2); `stripHopByHopHeaders` from `../service-proxy.js`.
- Produces:
  - `interface BrowserPreviewSubsystem { middleware(): RequestHandler; upgradeHandler(): (req: IncomingMessage, socket: Socket, head: Buffer) => void; }`
  - `function createBrowserPreviewSubsystem(options: { template: BrowserPreviewTemplate | null; logger: Logger }): BrowserPreviewSubsystem`

- [ ] **Step 1: Inspect the shape of the code being mirrored**

Read `packages/server/src/server/service-proxy.ts:247-420`. Note how `stripHopByHopHeaders` is called and how `proxyUpgradeRequest` pipes sockets. Mirror the socket handling; do **not** reuse the header construction.

- [ ] **Step 2: Add the export to `service-proxy.ts`**

Change line 247 from `function stripHopByHopHeaders(` to `export function stripHopByHopHeaders(`. Change nothing else.

- [ ] **Step 3: Write the failing test**

Create `packages/server/src/server/browser-preview/index.test.ts`:

```typescript
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrowserPreviewSubsystem } from "./index.js";
import { parseBrowserPreviewTemplate } from "./url-template.js";

const logger = pino({ level: "silent" });

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

describe("createBrowserPreviewSubsystem", () => {
  let upstream: Server;
  let proxy: Server;
  let upstreamPort = 0;
  let proxyPort = 0;
  let seenHost: string | undefined;
  let seenOrigin: string | undefined;

  beforeEach(async () => {
    upstream = createServer((req, res) => {
      seenHost = req.headers.host;
      seenOrigin = req.headers.origin;
      if (req.url === "/redirect") {
        res.writeHead(302, { location: `http://localhost:${upstreamPort}/landed` });
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "text/plain",
        "x-frame-options": "DENY",
        "content-security-policy": "frame-ancestors 'none'",
      });
      res.end("upstream-body");
    });
    upstreamPort = await listen(upstream);

    const app = express();
    const template = parseBrowserPreviewTemplate("https://{port}.preview.example.com");
    const subsystem = createBrowserPreviewSubsystem({ template, logger });
    app.use(subsystem.middleware());
    app.use((_req, res) => res.status(418).send("fell-through"));
    proxy = createServer(app);
    proxyPort = await listen(proxy);
  });

  afterEach(async () => {
    await new Promise((r) => upstream.close(r));
    await new Promise((r) => proxy.close(r));
  });

  const get = (path: string, host: string) =>
    fetch(`http://127.0.0.1:${proxyPort}${path}`, {
      headers: { host, origin: "https://app.example.com" },
      redirect: "manual",
    });

  it("proxies a matching host to the loopback port", async () => {
    const res = await get("/", `${upstreamPort}.preview.example.com`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream-body");
  });

  it("forges Host as localhost:<port> and drops Origin", async () => {
    await get("/", `${upstreamPort}.preview.example.com`);
    expect(seenHost).toBe(`localhost:${upstreamPort}`);
    expect(seenOrigin).toBeUndefined();
  });

  it("does not set X-Forwarded headers", async () => {
    let forwarded: string[] = [];
    const probe = createServer((req, res) => {
      forwarded = Object.keys(req.headers).filter((h) => h.startsWith("x-forwarded"));
      res.writeHead(200).end("ok");
    });
    const probePort = await listen(probe);
    await get("/", `${probePort}.preview.example.com`);
    expect(forwarded).toEqual([]);
    await new Promise((r) => probe.close(r));
  });

  it("strips framing headers from the response", async () => {
    const res = await get("/", `${upstreamPort}.preview.example.com`);
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  it("rewrites a loopback redirect onto the preview origin", async () => {
    const res = await get("/redirect", `${upstreamPort}.preview.example.com`);
    expect(res.headers.get("location")).toBe(`https://${upstreamPort}.preview.example.com/landed`);
  });

  it("calls next() for hosts that do not match the template", async () => {
    const res = await get("/", "daemon-1.studio.example.com");
    expect(res.status).toBe(418);
  });

  it("returns 502 when the loopback port is not listening", async () => {
    const res = await get("/", "9.preview.example.com");
    expect(res.status).toBe(502);
  });

  it("calls next() for every host when no template is configured", async () => {
    const app = express();
    const subsystem = createBrowserPreviewSubsystem({ template: null, logger });
    app.use(subsystem.middleware());
    app.use((_req, res) => res.status(418).send("fell-through"));
    const bare = createServer(app);
    const barePort = await listen(bare);
    const res = await fetch(`http://127.0.0.1:${barePort}/`, {
      headers: { host: `${upstreamPort}.preview.example.com` },
    });
    expect(res.status).toBe(418);
    await new Promise((r) => bare.close(r));
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run packages/server/src/server/browser-preview/index.test.ts --bail=1`
Expected: FAIL — cannot resolve `./index.js`.

- [ ] **Step 5: Write the implementation**

Create `packages/server/src/server/browser-preview/index.ts`:

```typescript
import http, { type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { RequestHandler } from "express";
import type { Logger } from "pino";
import { stripHopByHopHeaders } from "../service-proxy.js";
import { transformPreviewResponseHeaders } from "./response-headers.js";
import type { BrowserPreviewTemplate } from "./url-template.js";

// Dial "localhost" rather than a literal address. Node's autoSelectFamily
// (default true on Node >= 20) tries both loopback families, so a dev server
// bound only to ::1 still resolves — without a manual retry, which would have
// to pipe the request a second time and would forward an empty body for any
// request whose body the first pipe already consumed.
const UPSTREAM_HOST = "localhost";

export interface BrowserPreviewSubsystem {
  middleware(): RequestHandler;
  upgradeHandler(): (req: IncomingMessage, socket: Socket, head: Buffer) => void;
}

// The dev server must see the request as if it arrived on loopback directly:
// Host forged, Origin dropped, no X-Forwarded-* at all.
function buildUpstreamHeaders(req: IncomingMessage, port: number): NodeJS.Dict<string | string[]> {
  const headers = stripHopByHopHeaders(req.headers);
  delete headers.origin;
  headers.host = `localhost:${port}`;
  return headers;
}

export function createBrowserPreviewSubsystem(options: {
  template: BrowserPreviewTemplate | null;
  logger: Logger;
}): BrowserPreviewSubsystem {
  const { template } = options;
  const logger = options.logger.child({ module: "browser-preview" });

  function openUpstream(req: IncomingMessage, port: number, host: string) {
    return http.request({
      host,
      port,
      method: req.method,
      path: req.url,
      headers: buildUpstreamHeaders(req, port),
    });
  }

  return {
    middleware(): RequestHandler {
      return (req, res, next) => {
        const port = template?.matchHost(req.headers.host) ?? null;
        if (port === null || !template) {
          next();
          return;
        }

        const upstream = openUpstream(req, port, UPSTREAM_HOST);
        upstream.on("response", (upstreamRes) => {
          const headers = transformPreviewResponseHeaders({
            headers: stripHopByHopHeaders(upstreamRes.headers),
            targetPort: port,
            template,
          });
          res.writeHead(upstreamRes.statusCode ?? 502, headers);
          upstreamRes.pipe(res);
        });
        upstream.on("error", (error: NodeJS.ErrnoException) => {
          logger.debug({ err: error, port }, "browser_preview_upstream_failed");
          if (!res.headersSent) res.status(502).send("502 Bad Gateway");
          else res.end();
        });
        req.pipe(upstream);
      };
    },

    upgradeHandler() {
      return (req, socket, head) => {
        const port = template?.matchHost(req.headers.host) ?? null;
        if (port === null || !template) return; // leave the socket for the next listener

        const upstream = http.request({
          host: UPSTREAM_HOST,
          port,
          method: req.method,
          path: req.url,
          headers: buildUpstreamHeaders(req, port),
        });
        upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
          const lines = Object.entries(upstreamRes.headers).flatMap(([k, v]) =>
            Array.isArray(v) ? v.map((item) => `${k}: ${item}`) : v ? [`${k}: ${v}`] : [],
          );
          socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`);
          if (upstreamHead?.length) socket.write(upstreamHead);
          upstreamSocket.pipe(socket);
          socket.pipe(upstreamSocket);
          upstreamSocket.on("error", () => socket.destroy());
          socket.on("error", () => upstreamSocket.destroy());
        });
        upstream.on("error", (error) => {
          logger.debug({ err: error, port }, "browser_preview_upgrade_failed");
          socket.destroy();
        });
        if (head?.length) upstream.write(head);
        upstream.end();
      };
    },
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run packages/server/src/server/browser-preview/index.test.ts --bail=1`
Expected: PASS, 8 tests.

- [ ] **Step 7: Typecheck, lint, format, commit**

```bash
npm run typecheck
npm run lint -- packages/server/src/server/browser-preview/index.ts
npm run format
git add packages/server/src/server/browser-preview/ packages/server/src/server/service-proxy.ts
git commit -m "feat(server): add browser preview proxy middleware and upgrade handler"
```

---

### Task 4: Configuration

Follows the `serviceProxy` precedent exactly: env wins, persisted config is the fallback, invalid values throw at startup. The resolved field is **required** on the config type so that losing the call site during an upstream merge fails typecheck instead of silently unconfiguring the feature.

**Files:**

- Modify: `packages/server/src/server/persisted-config.ts` (add `browserPreview` beside `serviceProxy` at line 289)
- Modify: `packages/server/src/server/config.ts` (resolver near `resolveServiceProxyConfig` at line 277; call site near line 506; field in the returned object)
- Test: `packages/server/src/server/config-browser-preview.test.ts`

**Interfaces:**

- Consumes: `parseBrowserPreviewTemplate` (Task 1).
- Produces: `browserPreviewUrlTemplate: string | null` on the resolved daemon config — **required**, not optional.

- [ ] **Step 1: Read the precedent**

Read `packages/server/src/server/config.ts:265-300` (`resolveServiceProxyPublicBaseUrl`, `resolveServiceProxyConfig`) and `packages/server/src/server/persisted-config.ts:285-300`. Match their shape.

- [ ] **Step 2: Write the failing test**

Create `packages/server/src/server/config-browser-preview.test.ts`, mirroring the structure of the existing `config-web-ui.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { resolveBrowserPreviewUrlTemplate } from "./config.js";

describe("resolveBrowserPreviewUrlTemplate", () => {
  it("returns null when neither env nor persisted config sets one", () => {
    expect(resolveBrowserPreviewUrlTemplate({}, {})).toBeNull();
  });

  it("reads the persisted value", () => {
    expect(
      resolveBrowserPreviewUrlTemplate(
        {},
        { daemon: { browserPreview: { urlTemplate: "https://{port}.preview.example.com" } } },
      ),
    ).toBe("https://{port}.preview.example.com");
  });

  it("prefers the environment variable over persisted config", () => {
    expect(
      resolveBrowserPreviewUrlTemplate(
        { PASEO_BROWSER_PREVIEW_URL_TEMPLATE: "https://{port}--daemon-1.studio.example.com" },
        { daemon: { browserPreview: { urlTemplate: "https://{port}.preview.example.com" } } },
      ),
    ).toBe("https://{port}--daemon-1.studio.example.com");
  });

  it("throws on an invalid template so startup fails loudly", () => {
    expect(() =>
      resolveBrowserPreviewUrlTemplate(
        { PASEO_BROWSER_PREVIEW_URL_TEMPLATE: "https://no-placeholder.example.com" },
        {},
      ),
    ).toThrow(/Invalid PASEO_BROWSER_PREVIEW_URL_TEMPLATE/);
  });

  it("throws when the placeholder is in the path", () => {
    expect(() =>
      resolveBrowserPreviewUrlTemplate(
        { PASEO_BROWSER_PREVIEW_URL_TEMPLATE: "https://preview.example.com/{port}" },
        {},
      ),
    ).toThrow(/must appear in the hostname/);
  });
});
```

Adjust the second parameter's type to match whatever `loadPersistedConfig` returns; cast in the test if needed.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/server/src/server/config-browser-preview.test.ts --bail=1`
Expected: FAIL — `resolveBrowserPreviewUrlTemplate` is not exported.

- [ ] **Step 4: Add the persisted schema key**

In `packages/server/src/server/persisted-config.ts`, beside the `serviceProxy` block at line 289, add:

```typescript
        browserPreview: z
          .object({
            urlTemplate: z.string().optional(),
          })
          .optional(),
```

- [ ] **Step 5: Add the resolver and wire it in**

In `packages/server/src/server/config.ts`, next to `resolveServiceProxyConfig`:

```typescript
export function resolveBrowserPreviewUrlTemplate(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): string | null {
  const raw =
    env.PASEO_BROWSER_PREVIEW_URL_TEMPLATE ?? persisted.daemon?.browserPreview?.urlTemplate;
  if (!raw) return null;
  // Throws with an "Invalid PASEO_BROWSER_PREVIEW_URL_TEMPLATE: ..." message,
  // matching resolveServiceProxyPublicBaseUrl's convention at config.ts:272.
  parseBrowserPreviewTemplate(raw);
  return raw.trim();
}
```

Import `parseBrowserPreviewTemplate` from `./browser-preview/url-template.js`. Call it beside line 506:

```typescript
const browserPreviewUrlTemplate = resolveBrowserPreviewUrlTemplate(env, persisted);
```

and add to the returned object, beside `serviceProxy`:

```typescript
    browserPreviewUrlTemplate,
```

Declare it on the resolved config type as **required**: `browserPreviewUrlTemplate: string | null;` — not optional. This is what makes a dropped call site a typecheck failure.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run packages/server/src/server/config-browser-preview.test.ts --bail=1`
Expected: PASS, 5 tests.

- [ ] **Step 7: Typecheck, lint, format, commit**

`npm run typecheck` will now flag every construction site of the resolved config that lacks the required field, including test fixtures. Add `browserPreviewUrlTemplate: null` at each.

```bash
npm run typecheck
npm run lint -- packages/server/src/server/config.ts packages/server/src/server/persisted-config.ts
npm run format
git add packages/server/src/server/
git commit -m "feat(server): resolve browser preview URL template from env and config"
```

---

### Task 5: Mount the subsystem and anchor it with an integration test

The two mount lines fail **silently** if lost in an upstream merge — typecheck still passes and the feature simply stops routing. The integration test in this task is what makes that loss loud.

**Files:**

- Modify: `packages/server/src/server/bootstrap.ts:666` and `:812`
- Test: `packages/server/src/server/browser-preview/bootstrap-mount.test.ts`

**Interfaces:**

- Consumes: `createBrowserPreviewSubsystem` (Task 3), `browserPreviewUrlTemplate` on the resolved config (Task 4).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/server/browser-preview/bootstrap-mount.test.ts`. Follow the harness in `docs/ad-hoc-daemon-testing.md`:

```typescript
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import pino from "pino";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPaseoDaemon } from "../bootstrap.js";

const logger = pino({ level: "silent" });
let daemon: Awaited<ReturnType<typeof createPaseoDaemon>>;
let daemonPort = 0;
let upstream: Server;
let upstreamPort = 0;
let seenHost: string | undefined;
let paseoHomeRoot = "";
let staticDir = "";

beforeAll(async () => {
  upstream = createServer((req, res) => {
    seenHost = req.headers.host;
    res.writeHead(200, { "content-type": "text/plain" }).end("dev-server");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const addr = upstream.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  upstreamPort = addr.port;

  paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-preview-"));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));

  daemon = await createPaseoDaemon(
    {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      // Deliberately restrictive: proves preview hosts bypass the allowlist.
      hostnames: [],
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: {},
      agentStoragePath: path.join(paseoHome, "agents"),
      relayEnabled: false,
      relayEndpoint: "relay.paseo.sh:443",
      appBaseUrl: "https://app.paseo.sh",
      browserPreviewUrlTemplate: "https://{port}.preview.example.com",
    },
    logger,
  );
  daemonPort = daemon.port;
});

afterAll(async () => {
  await daemon.stop();
  await new Promise((r) => upstream.close(r));
  await rm(paseoHomeRoot, { recursive: true, force: true });
  await rm(staticDir, { recursive: true, force: true });
});

it("routes a preview Host to the loopback port with Host forged", async () => {
  const res = await fetch(`http://127.0.0.1:${daemonPort}/`, {
    headers: { host: `${upstreamPort}.preview.example.com` },
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("dev-server");
  expect(seenHost).toBe(`localhost:${upstreamPort}`);
});

it("still rejects a non-preview host that is not in the allowlist", async () => {
  const res = await fetch(`http://127.0.0.1:${daemonPort}/api/health`, {
    headers: { host: "evil.example.com" },
  });
  expect(res.status).toBe(403);
});
```

Adapt `createPaseoDaemon`'s return shape (port accessor, stop method) and the second argument to whatever `bootstrap.ts` actually exports — read its signature first. Adapt the daemon config object to satisfy its required fields.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/server/src/server/browser-preview/bootstrap-mount.test.ts --bail=1`
Expected: FAIL — the preview host is not routed (403 or 404).

- [ ] **Step 3: Mount the middleware**

In `packages/server/src/server/bootstrap.ts`, near line 627 where `serviceProxy` is constructed, add:

```typescript
const browserPreview = createBrowserPreviewSubsystem({
  template: config.browserPreviewUrlTemplate
    ? parseBrowserPreviewTemplate(config.browserPreviewUrlTemplate)
    : null,
  logger,
});
```

Immediately **before** `app.use(serviceProxy.middleware())` at line 666, add:

```typescript
// Browser preview resolves loopback ports for the web build. It must run
// before the service proxy: classifyHost's known-service-miss branches would
// otherwise 404 preview hosts under a configured public base. Like service
// routes, handled requests never reach the host allowlist at :669.
app.use(browserPreview.middleware());
```

- [ ] **Step 4: Mount the upgrade handler**

Immediately **before** line 812's `httpServer.on("upgrade", serviceProxy.upgradeHandler(...))`, add:

```typescript
// Registered first so preview upgrades are claimed before the service proxy
// and before VoiceAssistantWebSocketServer's own listener. No-op otherwise.
httpServer.on("upgrade", browserPreview.upgradeHandler());
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/server/src/server/browser-preview/bootstrap-mount.test.ts --bail=1`
Expected: PASS, 2 tests.

- [ ] **Step 6: Typecheck, lint, format, commit**

```bash
npm run typecheck
npm run lint -- packages/server/src/server/bootstrap.ts
npm run format
git add packages/server/src/server/
git commit -m "feat(server): mount browser preview proxy ahead of the service proxy"
```

---

### Task 6: Advertise the template over the protocol

`browserPreview` is a sibling object on the `server_info` payload, following the `urlOpeners` precedent at `packages/protocol/src/messages.ts:3216`. There is **no** `features.browserPreview` flag: a valid `urlTemplate` is the capability, so the two cannot disagree.

**Files:**

- Modify: `packages/protocol/src/messages.ts` (near line 3226, after the `urlOpeners` block, before `features` at `:3228`)
- Modify: `packages/server/src/server/websocket-server.ts` (wherever the `server_info` payload is built)
- Modify: `packages/app/src/stores/session-store.ts:286` (`DaemonServerInfo`)
- Test: extend `packages/server/src/server/browser-preview/bootstrap-mount.test.ts`

**Interfaces:**

- Consumes: `browserPreviewUrlTemplate` on the resolved config (Task 4).
- Produces: `server_info.browserPreview?: { urlTemplate?: string }` on the wire and on `DaemonServerInfo`.

- [ ] **Step 1: Add the wire field**

In `packages/protocol/src/messages.ts`, after the `urlOpeners` object closes and before `features`:

```typescript
    // COMPAT(browserPreview): added in v0.4.x, remove gate once daemon floor ships it.
    // Presence of a valid urlTemplate IS the capability; there is deliberately no
    // features.browserPreview flag, so the two can never disagree.
    browserPreview: z
      .object({
        urlTemplate: z.string().min(1).optional(),
      })
      .optional(),
```

Keep it optional and additive. No `.transform()`, `.catch()` or `.preprocess()`.

- [ ] **Step 2: Rebuild protocol declarations**

Run: `npm run build:client`
This regenerates the AOT validators and the declarations the server and app consume.

- [ ] **Step 3: Populate it in the daemon**

Find where `status: "server_info"` is constructed in `packages/server/src/server/websocket-server.ts` and add, alongside the existing `urlOpeners` population:

```typescript
      ...(config.browserPreviewUrlTemplate
        ? { browserPreview: { urlTemplate: config.browserPreviewUrlTemplate } }
        : {}),
```

Mirror however `urlOpeners` reaches that point — thread the value the same way rather than introducing a new accessor.

- [ ] **Step 4: Mirror the field on the app type**

In `packages/app/src/stores/session-store.ts`, add to `DaemonServerInfo` (line 286):

```typescript
  browserPreview?: { urlTemplate?: string } | null;
```

- [ ] **Step 5: Extend the anchor test**

Append to `packages/server/src/server/browser-preview/bootstrap-mount.test.ts`:

```typescript
it("advertises the configured template on server_info", async () => {
  const info = await fetchServerInfo(daemonPort);
  expect(info.browserPreview?.urlTemplate).toBe("https://{port}.preview.example.com");
});
```

Implement `fetchServerInfo` using the same client the other daemon tests use — see `packages/server/src/server/test-utils/daemon-client.ts` and how `daemon-client.e2e.test.ts` reads `server_info`. Do not hand-roll a WebSocket.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run packages/server/src/server/browser-preview/bootstrap-mount.test.ts --bail=1`
Expected: PASS, 3 tests.

- [ ] **Step 7: Typecheck, lint, format, commit**

```bash
npm run build:client
npm run typecheck
npm run lint -- packages/protocol/src/messages.ts packages/server/src/server/websocket-server.ts
npm run format
git add packages/protocol packages/server packages/app/src/stores/session-store.ts
git commit -m "feat(protocol): advertise browser preview URL template on server_info"
```

---

### Task 7: Per-host template selector, availability, and copy

`useHostFeature` (`packages/app/src/runtime/host-features.ts:32`) answers `boolean` only — `serverInfo?.features?.[feature] === true` — so it cannot carry the template string. This task adds a sibling selector and reworks the availability rule and its copy.

**Files:**

- Create: `packages/app/src/desktop/browser/workspace-browser-preview.ts`
- Test: `packages/app/src/desktop/browser/workspace-browser-preview.test.ts`
- Modify: `packages/app/src/desktop/browser/workspace-browser-availability.ts`
- Modify: `packages/app/src/desktop/browser/workspace-browser-availability.test.ts`
- Modify: all 9 files in `packages/app/src/i18n/resources/`
- Modify: `packages/app/src/i18n/resources.test.ts:284`

**Interfaces:**

- Consumes: `DaemonServerInfo.browserPreview` (Task 6).
- Produces:
  - `function selectBrowserPreviewTemplate(state: HostFeatureSessionState, serverId: string): string | null`
  - `function useBrowserPreviewTemplate(serverId: string | null | undefined): string | null`
  - `function buildBrowserPreviewUrl(template: string, port: number): string`
  - `resolveWorkspaceBrowserAvailability` gains `hasBrowserPreviewTemplate: boolean` on its input.

- [ ] **Step 1: Write the failing test for the selector**

Create `packages/app/src/desktop/browser/workspace-browser-preview.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildBrowserPreviewUrl, selectBrowserPreviewTemplate } from "./workspace-browser-preview";

const stateWith = (template: string | null) => ({
  sessions: {
    "srv-a": {
      serverInfo: template
        ? ({ browserPreview: { urlTemplate: template } } as never)
        : ({} as never),
    },
  },
});

describe("selectBrowserPreviewTemplate", () => {
  it("returns the template advertised by that host", () => {
    expect(
      selectBrowserPreviewTemplate(stateWith("https://{port}.preview.example.com"), "srv-a"),
    ).toBe("https://{port}.preview.example.com");
  });

  it("returns null when the host advertises none", () => {
    expect(selectBrowserPreviewTemplate(stateWith(null), "srv-a")).toBeNull();
  });

  it("returns null for an unknown server id", () => {
    expect(selectBrowserPreviewTemplate(stateWith("https://{port}.x.com"), "srv-b")).toBeNull();
  });
});

describe("buildBrowserPreviewUrl", () => {
  it("substitutes the port", () => {
    expect(buildBrowserPreviewUrl("https://{port}--daemon-1.studio.example.com", 3000)).toBe(
      "https://3000--daemon-1.studio.example.com",
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/app/src/desktop/browser/workspace-browser-preview.test.ts --bail=1`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the selector**

Create `packages/app/src/desktop/browser/workspace-browser-preview.ts`:

```typescript
import { useSessionStore } from "@/stores/session-store";
import type { HostFeatureSessionState } from "@/runtime/host-features";

export function selectBrowserPreviewTemplate(
  state: HostFeatureSessionState,
  serverId: string,
): string | null {
  const template = state.sessions[serverId]?.serverInfo?.browserPreview?.urlTemplate;
  return typeof template === "string" && template.length > 0 ? template : null;
}

export function useBrowserPreviewTemplate(serverId: string | null | undefined): string | null {
  const normalized = serverId?.trim() ?? "";
  return useSessionStore((state) => selectBrowserPreviewTemplate(state, normalized));
}

export function buildBrowserPreviewUrl(template: string, port: number): string {
  return template.replace("{port}", String(port));
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run packages/app/src/desktop/browser/workspace-browser-preview.test.ts --bail=1`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing availability test**

Add to `packages/app/src/desktop/browser/workspace-browser-availability.test.ts`:

```typescript
it("is available on web when the host advertises a preview template", () => {
  expect(
    resolveWorkspaceBrowserAvailability({
      isElectron: false,
      isAndroid: false,
      isWeb: true,
      hasTcpTunnel: false,
      hasBrowserPreviewTemplate: true,
    }),
  ).toBe(true);
});

it("is unavailable on web when the host advertises no template", () => {
  expect(
    resolveWorkspaceBrowserAvailability({
      isElectron: false,
      isAndroid: false,
      isWeb: true,
      hasTcpTunnel: false,
      hasBrowserPreviewTemplate: false,
    }),
  ).toBe(false);
});

it("stays available on Electron even with no template, since Electron reports web", () => {
  expect(
    resolveWorkspaceBrowserAvailability({
      isElectron: true,
      isAndroid: false,
      isWeb: true,
      hasTcpTunnel: false,
      hasBrowserPreviewTemplate: false,
    }),
  ).toBe(true);
});
```

Update the existing cases in that file to pass the two new input fields.

- [ ] **Step 6: Run it to verify it fails, then implement**

Run: `npx vitest run packages/app/src/desktop/browser/workspace-browser-availability.test.ts --bail=1`
Expected: FAIL — unknown properties.

Then rewrite `resolveWorkspaceBrowserAvailability` in `workspace-browser-availability.ts`:

```typescript
export interface WorkspaceBrowserAvailabilityInput {
  isElectron: boolean;
  isAndroid: boolean;
  isWeb: boolean;
  hasTcpTunnel: boolean;
  hasBrowserPreviewTemplate: boolean;
}

export function resolveWorkspaceBrowserAvailability(
  input: WorkspaceBrowserAvailabilityInput,
): boolean {
  // Electron must short-circuit: it also reports Platform.OS === "web", but it
  // routes loopback through its own session proxy and needs no template.
  if (input.isElectron) {
    return true;
  }
  if (input.isAndroid) {
    return input.hasTcpTunnel;
  }
  return input.isWeb && input.hasBrowserPreviewTemplate;
}
```

Update `useWorkspaceBrowserAvailability` to pass `isWeb` from `@/constants/platform` and `hasBrowserPreviewTemplate` from `useBrowserPreviewTemplate(serverId) !== null`.

- [ ] **Step 7: Run it to verify it passes**

Run: `npx vitest run packages/app/src/desktop/browser/workspace-browser-availability.test.ts --bail=1`
Expected: PASS.

- [ ] **Step 8: Update the copy in all 9 locales**

`packages/app/src/i18n/resources.test.ts:284` asserts `en.workspace.browser.unavailable.title` is `"Browser is desktop-only"`, which stops being true. Under `workspace.browser` in `en.ts`, replace the `unavailable` block with two distinct states:

```typescript
      unavailable: {
        title: "Browser isn't available here",
        subtitle: "Open this workspace in the desktop app to use Browser.",
      },
      previewNotConfigured: {
        title: "Browser isn't set up on this host",
        subtitle:
          "Set browserPreview.urlTemplate on this host to browse its localhost ports from the web app. Browser already works for this workspace in the desktop app.",
      },
```

Add the same keys, translated, to `ar.ts`, `es.ts`, `fr.ts`, `ja.ts`, `ko.ts`, `pt-BR.ts`, `ru.ts`, `zh-CN.ts`. `resources.test.ts:109-116` asserts exact key parity and will fail on any omission, and `:119-126` fails if more than 25% of a locale's strings are identical to English, so these must be genuinely translated.

Update the assertion at `resources.test.ts:284` to the new English title.

- [ ] **Step 9: Run the i18n tests**

Run: `npx vitest run packages/app/src/i18n/resources.test.ts --bail=1`
Expected: PASS.

- [ ] **Step 10: Typecheck, lint, format, commit**

```bash
npm run typecheck
npm run lint -- packages/app/src/desktop/browser packages/app/src/i18n
npm run format
git add packages/app/src
git commit -m "feat(app): select per-host browser preview template and split unavailable copy"
```

---

### Task 8: Web Browser pane

Replaces the placeholder at `packages/app/src/desktop/browser/pane/index.web.tsx` with an iframe. The pane receives `browserId`, and the current URL lives on the browser record — `BrowserRecord.url` in `packages/app/src/desktop/browser/store/state.ts:9-20`, read via `getBrowserRecord(browserId)` from `store/index.ts:89`.

**Files:**

- Modify: `packages/app/src/desktop/browser/pane/index.web.tsx`
- Create: `packages/app/src/desktop/browser/pane/web-preview-url.ts`
- Test: `packages/app/src/desktop/browser/pane/web-preview-url.test.ts`

**Interfaces:**

- Consumes: `buildBrowserPreviewUrl`, `useBrowserPreviewTemplate` (Task 7); `BrowserPaneProps` as already declared in `index.web.tsx`; `useBrowserStore` / `getBrowserRecord` from `@/desktop/browser/store`.
- Produces: `function resolveWebBrowserSrc(input: { url: string; template: string | null }): { kind: "preview"; src: string } | { kind: "direct"; src: string } | { kind: "rejected"; reason: "unspecified-address" } | { kind: "no-template" }`

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/desktop/browser/pane/web-preview-url.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { resolveWebBrowserSrc } from "./web-preview-url";

const template = "https://{port}--daemon-1.studio.example.com";

describe("resolveWebBrowserSrc", () => {
  it("routes localhost with a port through the template", () => {
    expect(resolveWebBrowserSrc({ url: "http://localhost:3000/app", template })).toEqual({
      kind: "preview",
      src: "https://3000--daemon-1.studio.example.com/app",
    });
  });

  it("routes 127.0.0.1 and [::1] through the template", () => {
    expect(resolveWebBrowserSrc({ url: "http://127.0.0.1:5173/", template })).toEqual({
      kind: "preview",
      src: "https://5173--daemon-1.studio.example.com/",
    });
    expect(resolveWebBrowserSrc({ url: "http://[::1]:5173/", template })).toEqual({
      kind: "preview",
      src: "https://5173--daemon-1.studio.example.com/",
    });
  });

  it("preserves query and hash", () => {
    expect(resolveWebBrowserSrc({ url: "http://localhost:3000/a?b=1#c", template }).src).toBe(
      "https://3000--daemon-1.studio.example.com/a?b=1#c",
    );
  });

  it("rejects unspecified addresses as destinations", () => {
    expect(resolveWebBrowserSrc({ url: "http://0.0.0.0:3000/", template })).toEqual({
      kind: "rejected",
      reason: "unspecified-address",
    });
    expect(resolveWebBrowserSrc({ url: "http://[::]:3000/", template })).toEqual({
      kind: "rejected",
      reason: "unspecified-address",
    });
  });

  it("loads non-loopback URLs directly", () => {
    expect(resolveWebBrowserSrc({ url: "https://example.com/x", template })).toEqual({
      kind: "direct",
      src: "https://example.com/x",
    });
  });

  it("reports no-template only for loopback URLs", () => {
    expect(resolveWebBrowserSrc({ url: "http://localhost:3000/", template: null })).toEqual({
      kind: "no-template",
    });
    expect(resolveWebBrowserSrc({ url: "https://example.com/", template: null })).toEqual({
      kind: "direct",
      src: "https://example.com/",
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/app/src/desktop/browser/pane/web-preview-url.test.ts --bail=1`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the resolver**

Create `packages/app/src/desktop/browser/pane/web-preview-url.ts`:

```typescript
import { buildBrowserPreviewUrl } from "@/desktop/browser/workspace-browser-preview";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);
// Valid listen addresses, never valid destinations. Rejected to match Android.
const UNSPECIFIED_HOSTNAMES = new Set(["0.0.0.0", "::"]);

export type WebBrowserSrc =
  | { kind: "preview"; src: string }
  | { kind: "direct"; src: string }
  | { kind: "rejected"; reason: "unspecified-address" }
  | { kind: "no-template" };

export function resolveWebBrowserSrc(input: {
  url: string;
  template: string | null;
}): WebBrowserSrc {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { kind: "direct", src: input.url };
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (UNSPECIFIED_HOSTNAMES.has(hostname)) {
    return { kind: "rejected", reason: "unspecified-address" };
  }
  if (!LOOPBACK_HOSTNAMES.has(hostname)) {
    return { kind: "direct", src: input.url };
  }
  if (!input.template) {
    return { kind: "no-template" };
  }

  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  const base = new URL(buildBrowserPreviewUrl(input.template, port));
  base.pathname = parsed.pathname;
  base.search = parsed.search;
  base.hash = parsed.hash;
  return { kind: "preview", src: base.toString() };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run packages/app/src/desktop/browser/pane/web-preview-url.test.ts --bail=1`
Expected: PASS, 6 tests.

- [ ] **Step 5: Render the iframe**

Rewrite `packages/app/src/desktop/browser/pane/index.web.tsx`. Keep the exported `BrowserPane` name and the existing `BrowserPaneProps` interface unchanged — `panel.tsx:63` and `code-server-panel.tsx:54` both pass that exact prop set. Read the current URL from the browser store by `browserId`, call `useBrowserPreviewTemplate(serverId)`, pass both to `resolveWebBrowserSrc`, and then:

- `preview` / `direct` — render `<iframe src={src} style={{ flex: 1, border: "none", width: "100%", height: "100%" }} title={t("workspace.browser.title")} />`. Guard the DOM element with `isWeb` from `@/constants/platform`; this file is web-only, but the guard documents it.
- `no-template` — render `previewNotConfigured.title` / `.subtitle` from the locale keys added in Task 7.
- `rejected` — render the existing `unavailable` block with a message naming the address as unusable.

Do not add navigation-event wiring. A cross-origin iframe emits no navigation events to its parent, so the address bar shows the last URL Paseo set. This is a known limitation recorded in the spec, not an oversight.

- [ ] **Step 6: Typecheck, lint, format**

```bash
npm run typecheck
npm run lint -- packages/app/src/desktop/browser/pane
npm run format
```

- [ ] **Step 7: Verify by hand against a real daemon**

Per `docs/qa.md`, this needs UI proof. Configure a dev daemon with `PASEO_BROWSER_PREVIEW_URL_TEMPLATE`, start a dev server on a port, open the web app, and confirm: the page renders, the address bar reads `localhost:<port>`, and HMR survives an edit. Capture a screenshot for the PR.

- [ ] **Step 8: Commit**

```bash
git add packages/app/src/desktop/browser
git commit -m "feat(app): render the web Browser pane through the host preview origin"
```

---

### Task 9: Documentation

**Files:**

- Modify: `docs/browser-localhost-routing.md`

**Interfaces:**

- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Add the web section**

Add a "Web build" section alongside the existing Electron and Android sections. Cover: the template config with both shapes (dedicated wildcard and shared orchestrated wildcard), `PASEO_BROWSER_PREVIEW_URL_TEMPLATE`, the DNS and reverse-proxy requirements including `proxy_set_header Host $http_host`, the fact that each daemon advertises its own template so a mixed fleet needs no client configuration, and that relay hosts are not supported in this version.

- [ ] **Step 2: State the port exposure**

Where the template is introduced, state plainly that configuring it makes **every** loopback port on that machine reachable by anyone who can resolve the hostname — not only dev servers — and that operators fronting a fleet should require auth at the ingress. Link to `docs/service-proxy.md` for the existing precedent; do not edit that file.

- [ ] **Step 3: Record the fork rationale**

In the same voice as the existing "Browser profile compatibility" section, record why the structure is what it is, so a future upstream sync does not "tidy" it:

- Classification rides Express mount order rather than a branch in `classifyHost`, to keep `service-proxy.ts` unedited apart from two `export` keywords.
- The forwarding policy is owned rather than shared, because `proxyHttpRequest` bakes in `X-Forwarded-*` and `Host` passthrough, which preview inverts.
- Preview hosts bypass the host allowlist by construction, exactly as service routes do, because handled requests never call `next()`.

- [ ] **Step 4: Note the known limitations**

The address bar does not follow in-page navigation, because a cross-origin iframe emits no navigation events. Service scripts already exposed on a service hostname are reachable at two origins with separate cookie jars, and that is intended.

- [ ] **Step 5: Format and commit**

```bash
npm run format
git add docs/browser-localhost-routing.md
git commit -m "docs: document web build Browser localhost routing"
```
