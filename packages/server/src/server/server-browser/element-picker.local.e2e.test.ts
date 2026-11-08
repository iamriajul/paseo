import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ServerBrowserElementSelectionSchema } from "@getpaseo/protocol/server-browser/rpc-schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cancelPick, pickElement, type PickOutcome } from "./element-picker.js";
import { ServerBrowserHost } from "./server-browser-host.js";
import type { ServerBrowserTab } from "./server-browser-tab.js";

// Local-only: needs a Chromium on this machine (`npx playwright install chromium-headless-shell`).

// A tall page scrolled 600 px down, so a crop that ignored the scroll would land on the wrong
// pixels. The target is solid red at a known spot with a React dev-build fiber on it.
const PAGE = `<!doctype html><title>Pick</title>
<style>body{margin:0;height:3000px;background:#fff} #target{position:absolute;left:100px;top:700px;width:200px;height:50px;background:rgb(255,0,0)}</style>
<div id=app><section class="card main"><div id=target class="btn primary">Save draft</div></section></div>
<script>
  var target = document.getElementById('target');
  target['__reactFiber$test'] = {
    type: function SaveButton() {},
    _debugSource: { fileName: '/src/components/SaveButton.tsx', lineNumber: 12, columnNumber: 7 },
    _debugOwner: null,
    return: null
  };
  target.addEventListener('click', function() { document.title = 'clicked'; });
  window.scrollTo(0, 600);
</script>`;

let paseoHome: string;
let site: http.Server;
let siteUrl: string;
let host: ServerBrowserHost;

beforeEach(async () => {
  paseoHome = mkdtempSync(join(tmpdir(), "element-picker-"));
  site = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(req.url === "/other" ? "<title>Other</title>" : PAGE);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const address = site.address();
  siteUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
  host = new ServerBrowserHost({
    paseoHome,
    logger: pino({ level: "silent" }),
    isEnabled: () => true,
  });
});

afterEach(async () => {
  await host.shutdown();
  await new Promise<void>((resolve) => site.close(() => resolve()));
  rmSync(paseoHome, { recursive: true, force: true });
});

async function openTab(): Promise<ServerBrowserTab> {
  const { browserId } = await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "user" });
  const tab = host.getTab(browserId)!;
  await waitFor(async () => (await tab.contents.executeJavaScript("window.scrollY")) === 600);
  return tab;
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The viewer's fraction-of-frame coordinates for a CSS point in the viewport. */
function fraction(tab: ServerBrowserTab, x: number, y: number): { x: number; y: number } {
  const { width, height } = tab.currentViewport;
  return { x: x / width, y: y / height };
}

async function waitForArmed(tab: ServerBrowserTab): Promise<void> {
  await waitFor(async () =>
    Boolean(
      await tab.contents.executeJavaScript(
        "document.documentElement.classList.contains('__paseo-select-mode')",
      ),
    ),
  );
}

/** Reads one pixel of a base64 PNG by decoding it in the page itself. */
async function pngPixel(
  tab: ServerBrowserTab,
  data: string,
): Promise<{ width: number; height: number; rgb: number[] }> {
  return (await tab.contents.executeJavaScript(`new Promise(function(resolve) {
    var image = new Image();
    image.onload = function() {
      var canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      var context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      var p = context.getImageData(image.width >> 1, image.height >> 1, 1, 1).data;
      resolve({ width: image.width, height: image.height, rgb: [p[0], p[1], p[2]] });
    };
    image.src = 'data:image/png;base64,${data}';
  })`)) as { width: number; height: number; rgb: number[] };
}

describe("pickElement with a real Chromium", () => {
  it("highlights under the pointer, then returns the selector script's selection and a crop", async () => {
    const tab = await openTab();
    const picking = pickElement(tab.contents);
    await waitForArmed(tab);

    // The target is at document y 700, viewport y 100 after the 600 px scroll.
    const point = fraction(tab, 150, 120);
    await tab.dispatchInput([
      { kind: "mouse", action: "move", ...point, button: "none", clickCount: 0 },
    ]);
    expect(
      await tab.contents.executeJavaScript(
        "document.getElementById('target').classList.contains('__paseo-hover')",
      ),
    ).toBe(true);

    await tab.dispatchInput([
      { kind: "mouse", action: "down", ...point, button: "left", clickCount: 1 },
      { kind: "mouse", action: "up", ...point, button: "left", clickCount: 1 },
    ]);
    const result = (await picking) as Extract<PickOutcome, { outcome: "selected" }>;

    expect(result.outcome).toBe("selected");
    expect(ServerBrowserElementSelectionSchema.parse(result.selection)).toEqual(result.selection);
    expect(result.selection).toMatchObject({
      tag: "div",
      text: "Save draft",
      selector: "#target",
      url: siteUrl,
      boundingRect: { x: 100, y: 100, width: 200, height: 50 },
      reactSource: {
        fileName: "/src/components/SaveButton.tsx",
        lineNumber: 12,
        columnNumber: 7,
        componentName: "SaveButton",
      },
      parentChain: ["section.card.main", "div#app", "body", "html"],
      children: [],
    });
    expect(result.selection.computedStyles["background-color"]).toBe("rgb(255, 0, 0)");
    expect(result.selection.outerHTML).toBe(
      '<div id="target" class="btn primary">Save draft</div>',
    );

    // The click picked the element without pressing it, and the overlay is gone.
    expect(await tab.contents.executeJavaScript("document.title")).toBe("Pick");
    expect(
      await tab.contents.executeJavaScript(
        "document.documentElement.classList.contains('__paseo-select-mode')",
      ),
    ).toBe(false);

    expect(result.screenshot?.mimeType).toBe("image/png");
    const pixel = await pngPixel(tab, result.screenshot!.data);
    expect(pixel).toEqual({ width: 200, height: 50, rgb: [255, 0, 0] });
  });

  it("maps the phone viewport's fractions onto the same element", async () => {
    const tab = await openTab();
    await tab.setViewport({ width: 390, height: 844, mobile: true });
    const picking = pickElement(tab.contents);
    await waitForArmed(tab);
    const point = fraction(tab, 290, 140);
    await tab.dispatchInput([
      { kind: "mouse", action: "move", ...point, button: "none", clickCount: 0 },
      { kind: "mouse", action: "down", ...point, button: "left", clickCount: 1 },
      { kind: "mouse", action: "up", ...point, button: "left", clickCount: 1 },
    ]);
    const result = (await picking) as Extract<PickOutcome, { outcome: "selected" }>;
    expect(result.selection.selector).toBe("#target");
    // Device pixels at the phone's scale factor of 2.
    const pixel = await pngPixel(tab, result.screenshot!.data);
    expect(pixel).toEqual({ width: 400, height: 100, rgb: [255, 0, 0] });
  });

  it("cancels on cancelPick, on Escape in the page, on navigation and on a second pick", async () => {
    const tab = await openTab();
    const armed = () =>
      tab.contents.executeJavaScript(
        "document.documentElement.classList.contains('__paseo-select-mode')",
      );

    const first = pickElement(tab.contents);
    await waitForArmed(tab);
    cancelPick(tab.contents);
    expect(await first).toEqual({ outcome: "cancelled" });
    expect(await armed()).toBe(false);

    const escaped = pickElement(tab.contents);
    await waitForArmed(tab);
    await tab.dispatchInput([
      { kind: "key", action: "down", key: "Escape", code: "Escape", keyCode: 27 },
    ]);
    expect(await escaped).toEqual({ outcome: "cancelled" });

    const replaced = pickElement(tab.contents);
    await waitForArmed(tab);
    const second = pickElement(tab.contents);
    expect(await replaced).toEqual({ outcome: "cancelled" });
    await waitForArmed(tab);

    await tab.navigate(`${siteUrl}other`);
    expect(await second).toEqual({ outcome: "cancelled" });

    const aborter = new AbortController();
    await tab.navigate(siteUrl);
    await waitFor(async () => (await tab.contents.executeJavaScript("window.scrollY")) === 600);
    const aborted = pickElement(tab.contents, aborter.signal);
    await waitForArmed(tab);
    aborter.abort();
    expect(await aborted).toEqual({ outcome: "cancelled" });
    expect(await armed()).toBe(false);
  });
});
