// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_SOURCE, COMMAND_SOURCE } from "./protocol.js";
import { SELECTOR_SCRIPT } from "./selector-script.js";

interface BridgeMessage {
  source: string;
  type: string;
  payload: Record<string, unknown>;
}

declare global {
  interface Window {
    __paseoSelector?: { destroy: () => void };
  }
}

const MODE_CLASS = "__paseo-select-mode";

// window.parent === window under jsdom, so the bridge posts to the same window
// the test owns. Capture before installing.
function captureMessages(): BridgeMessage[] {
  const sent: BridgeMessage[] = [];
  vi.spyOn(window.parent, "postMessage").mockImplementation((message: unknown) => {
    sent.push(message as BridgeMessage);
  });
  return sent;
}

// The browser evaluates the script as inline <head> markup; new Function is the
// closest equivalent that still runs it against this window's globals.
function install(): void {
  new Function(SELECTOR_SCRIPT)();
}

function runScript(): BridgeMessage[] {
  const sent = captureMessages();
  install();
  return sent;
}

// The bridge only obeys its embedder, and window.parent === window in jsdom, so
// a legitimate command is one whose event.source is this window.
function command(data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data, source: window.parent }));
}

function startSelect(): void {
  command({ source: COMMAND_SOURCE, command: "start-select" });
}

function armed(): boolean {
  return document.documentElement.classList.contains(MODE_CLASS);
}

function overlayNodes(): number {
  return document.querySelectorAll("#paseo-selector-styles, .__paseo-hover-label").length;
}

function click(target: Element): void {
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function hover(target: Element): void {
  target.dispatchEvent(
    new MouseEvent("mousemove", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
  );
}

function escape(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

function only(sent: BridgeMessage[], type: string): BridgeMessage {
  const matching = sent.filter((message) => message.type === type);
  expect(matching).toHaveLength(1);
  return matching[0] as BridgeMessage;
}

function label(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".__paseo-hover-label");
}

describe("SELECTOR_SCRIPT", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    // Every instance registers a command listener and may leave eleven
    // capture-phase handlers on the shared document. Without this, one test's
    // overlay reports the next test's clicks.
    window.__paseoSelector?.destroy();
    document.documentElement.classList.remove(MODE_CLASS);
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("installs no overlay until the parent asks", () => {
    runScript();
    expect(armed()).toBe(false);
    expect(overlayNodes()).toBe(0);
    expect(window.__paseoSelector).toBeDefined();
  });

  it("arms the overlay on start-select", () => {
    runScript();
    startSelect();
    expect(armed()).toBe(true);
    expect(overlayNodes()).toBe(2);
  });

  it("ignores a start-select from a window that is not the embedder", () => {
    runScript();
    // A nested third-party frame — an ad, a checkout widget — can postMessage
    // to its embedder. It executes inside the preview origin, so nothing the
    // parent checks afterwards can tell the difference.
    const frame = document.createElement("iframe");
    document.body.append(frame);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: COMMAND_SOURCE, command: "start-select" },
        source: frame.contentWindow,
      }),
    );
    expect(armed()).toBe(false);
  });

  it("ignores messages from an unknown source and commands it does not own", () => {
    runScript();
    command({ source: "somebody-else", command: "start-select" });
    command({ source: COMMAND_SOURCE, command: "toggle-eruda" });
    command({ source: COMMAND_SOURCE });
    expect(armed()).toBe(false);

    // The control: the refusals above have to be the guards, not a start
    // handler that stopped working.
    startSelect();
    expect(armed()).toBe(true);
  });

  it("reports the clicked element as a BrowserElementSelection", () => {
    document.body.innerHTML =
      '<section id="host"><article class="card wide"><b>a</b><i>b</i></article></section>';
    const target = document.querySelector("article") as HTMLElement;
    // jsdom implements no layout, so innerText is undefined and the port's
    // (el.innerText || '') would read '' for every element.
    Object.defineProperty(target, "innerText", { configurable: true, value: "ab" });

    const sent = runScript();
    startSelect();
    click(target);

    const payload = only(sent, "selection").payload;
    expect(only(sent, "selection").source).toBe(BRIDGE_SOURCE);
    // Field for field what BrowserElementSelection declares — anything missing
    // here is a field buildBrowserElementAttachment reads and would not find.
    expect(Object.keys(payload).sort()).toEqual([
      "boundingRect",
      "children",
      "computedStyles",
      "outerHTML",
      "parentChain",
      "reactSource",
      "selector",
      "tag",
      "text",
      "url",
    ]);
    expect(payload.tag).toBe("article");
    expect(payload.text).toBe("ab");
    expect(payload.url).toBe(location.href);
    expect(payload.outerHTML).toBe('<article class="card wide"><b>a</b><i>b</i></article>');
    expect(payload.selector).toBe("#host > article");
    expect(payload.parentChain).toEqual(["section#host", "body", "html"]);
    expect(payload.children).toEqual(["b", "i"]);
    expect(payload.reactSource).toBeNull();
    expect(payload.boundingRect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect((payload.computedStyles as Record<string, string>).display).toBe("block");
  });

  it("sends a payload postMessage can actually clone", () => {
    document.body.innerHTML = '<div data-x="1" style="color:red">hi</div>';
    const sent = runScript();
    startSelect();
    click(document.querySelector("div") as HTMLElement);
    // The Electron original carried el.attributes-derived data; a live
    // NamedNodeMap or any DOM node in the payload throws here rather than in
    // production, where postMessage would drop the whole message.
    expect(() => structuredClone(only(sent, "selection").payload)).not.toThrow();
  });

  it("disambiguates siblings with nth-of-type when there is no id", () => {
    document.body.innerHTML = "<p>one</p><p>two</p><p>three</p>";
    const sent = runScript();
    startSelect();
    click(document.querySelectorAll("p")[2] as HTMLElement);
    expect(only(sent, "selection").payload.selector).toBe("html > body > p:nth-of-type(3)");
  });

  it("reports the React source when the page exposes a fiber", () => {
    document.body.innerHTML = "<button>go</button>";
    const target = document.querySelector("button") as HTMLElement & Record<string, unknown>;
    target.__reactFiber$abc = {
      _debugSource: { fileName: "src/App.tsx", lineNumber: 12, columnNumber: 3 },
      type: { displayName: "SubmitButton" },
    };
    const sent = runScript();
    startSelect();
    click(target);
    expect(only(sent, "selection").payload.reactSource).toEqual({
      fileName: "src/App.tsx",
      lineNumber: 12,
      columnNumber: 3,
      componentName: "SubmitButton",
    });
  });

  it("swallows the click instead of letting the page act on it", () => {
    document.body.innerHTML = '<a href="/elsewhere">link</a>';
    const target = document.querySelector("a") as HTMLElement;
    const pageHandler = vi.fn();
    target.addEventListener("click", pageHandler);
    document.body.addEventListener("click", pageHandler);

    const sent = runScript();
    startSelect();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);

    // Picking an element must not also press the button it happens to be on.
    expect(pageHandler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(only(sent, "selection").payload.tag).toBe("a");
  });

  it("outlines the hovered element and labels it", () => {
    document.body.innerHTML = '<div class="row">x</div>';
    const target = document.querySelector("div") as HTMLElement;
    runScript();
    startSelect();
    hover(target);
    expect(target.classList.contains("__paseo-hover")).toBe(true);
    expect(label()?.textContent).toContain("div");
    expect(label()?.textContent).toContain(".row");
  });

  it("escapes page-controlled text before it reaches the hover label", () => {
    document.body.innerHTML = "<div>x</div>";
    const target = document.querySelector("div") as HTMLElement;
    // An id is page-controlled and may contain markup; the label builds its
    // content with innerHTML, so an unescaped id would run as the page's own.
    target.id = 'a"><img src=x onerror=alert(1)>';
    runScript();
    startSelect();
    hover(target);
    expect(label()?.querySelector("img")).toBeNull();
    expect(label()?.textContent).toContain("onerror=alert(1)");
  });

  it("tears the overlay down once it has reported a selection", () => {
    document.body.innerHTML = "<div>x</div>";
    const target = document.querySelector("div") as HTMLElement;
    const sent = runScript();
    startSelect();
    hover(target);
    click(target);
    expect(armed()).toBe(false);
    expect(overlayNodes()).toBe(0);
    expect(target.classList.contains("__paseo-hover")).toBe(false);
    // A second click lands on an unarmed page, so nothing more is reported.
    click(target);
    expect(sent.filter((message) => message.type === "selection")).toHaveLength(1);
  });

  it("cancels on Escape", () => {
    document.body.innerHTML = "<div>x</div>";
    const sent = runScript();
    startSelect();
    escape();
    expect(armed()).toBe(false);
    expect(overlayNodes()).toBe(0);
    expect(only(sent, "select-cancelled").source).toBe(BRIDGE_SOURCE);
    click(document.querySelector("div") as HTMLElement);
    expect(sent.filter((message) => message.type === "selection")).toHaveLength(0);
  });

  it("cancels on a cancel-select command, armed or not", () => {
    const sent = runScript();
    startSelect();
    command({ source: COMMAND_SOURCE, command: "cancel-select" });
    expect(armed()).toBe(false);
    // Answered even with nothing armed: a frame that reloaded mid-selection has
    // no overlay left, and silence there strands the app showing 'selecting'.
    command({ source: COMMAND_SOURCE, command: "cancel-select" });
    expect(sent.filter((message) => message.type === "select-cancelled")).toHaveLength(2);
  });

  it("replaces a previous instance instead of stacking a second one", () => {
    document.body.innerHTML = "<div>x</div>";
    const sent = captureMessages();
    install();
    install();
    startSelect();
    // Two live instances each answer the command and each build an overlay.
    // Counting selections would not see it: the first one's
    // stopImmediatePropagation hides the click from the second.
    expect(overlayNodes()).toBe(2);
    click(document.querySelector("div") as HTMLElement);
    expect(sent.filter((message) => message.type === "selection")).toHaveLength(1);
    // And the instance that lost that race never tears down, so its overlay
    // and its eleven capture handlers would outlive the selection.
    expect(overlayNodes()).toBe(0);
    expect(armed()).toBe(false);
  });

  it("goes quiet after destroy", () => {
    document.body.innerHTML = "<div>x</div>";
    const sent = runScript();
    startSelect();
    window.__paseoSelector?.destroy();

    // Nothing of ours is left on the window: no handle, no overlay, no command
    // listener, no capture handlers on the document.
    expect(window.__paseoSelector).toBeUndefined();
    expect(armed()).toBe(false);
    expect(overlayNodes()).toBe(0);
    const before = sent.length;
    startSelect();
    click(document.querySelector("div") as HTMLElement);
    escape();
    expect(sent.slice(before)).toEqual([]);
  });
});
