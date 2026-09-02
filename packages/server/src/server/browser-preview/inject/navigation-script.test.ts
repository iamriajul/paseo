// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NAVIGATION_SCRIPT } from "./navigation-script.js";
import { BRIDGE_SOURCE, COMMAND_SOURCE } from "./protocol.js";

interface BridgeMessage {
  source: string;
  type: string;
  payload: Record<string, unknown>;
}

declare global {
  interface Window {
    __paseoNavigationBridge?: { destroy: () => void };
  }
}

// jsdom exposes window.location as a configurable accessor, so a test can swap
// it for a stub — but the swap sticks for the rest of the file. Capturing the
// descriptor once and restoring it after every test is what keeps the goto test
// from leaking a fake location into whatever runs next.
const LOCATION_DESCRIPTOR = Object.getOwnPropertyDescriptor(window, "location");

// sessionStorage is not an instance of the global Storage in jsdom — it is a
// proxy over a different prototype — so spying on Storage.prototype.getItem
// intercepts nothing and a "storage is blocked" test built that way passes no
// matter what the script does. Swapping the accessor is what actually blocks it.
const SESSION_STORAGE_DESCRIPTOR = Object.getOwnPropertyDescriptor(window, "sessionStorage");

function blockSessionStorage(): void {
  const blocked = (): never => {
    throw new Error("blocked");
  };
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    value: { getItem: blocked, setItem: blocked, removeItem: blocked, clear: blocked },
    writable: true,
  });
}

// jsdom serves document.referrer from Document.prototype, so an own property
// shadows it and deleting that own property puts the real getter back.
function setReferrer(value: string): void {
  Object.defineProperty(document, "referrer", { configurable: true, value });
}

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
  new Function(NAVIGATION_SCRIPT)();
}

function runScript(): BridgeMessage[] {
  const sent = captureMessages();
  install();
  return sent;
}

function navigations(sent: BridgeMessage[]): BridgeMessage[] {
  return sent.filter((message) => message.type === "navigation");
}

// The bridge only obeys its embedder, and window.parent === window in jsdom, so
// a legitimate command is one whose event.source is this window.
function command(data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data, source: window.parent }));
}

describe("NAVIGATION_SCRIPT", () => {
  beforeEach(() => {
    // The bridge persists its stack in sessionStorage, which outlives a test in
    // the same jsdom window. Left alone, one test's stack seeds the next one's
    // canGoBack and results depend on order.
    sessionStorage.clear();
    history.replaceState(null, "", "/start");
    // document.title and the body outlive a test in this window.
    document.title = "";
    document.body.innerHTML = "";
  });

  afterEach(() => {
    // Every instance patches history, adds five listeners and starts an
    // interval on a window shared by the whole file. Without this, later tests
    // read earlier instances' messages.
    window.__paseoNavigationBridge?.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (LOCATION_DESCRIPTOR) {
      Object.defineProperty(window, "location", LOCATION_DESCRIPTOR);
    }
    if (SESSION_STORAGE_DESCRIPTOR) {
      Object.defineProperty(window, "sessionStorage", SESSION_STORAGE_DESCRIPTOR);
    }
    Reflect.deleteProperty(document, "referrer");
  });

  it("announces itself with ready", () => {
    const sent = runScript();
    expect(sent.some((m) => m.source === BRIDGE_SOURCE && m.type === "ready")).toBe(true);
  });

  it("reports the initial navigation with canGoBack false", () => {
    const sent = runScript();
    const nav = navigations(sent).at(-1);
    expect(nav?.source).toBe(BRIDGE_SOURCE);
    expect(nav?.payload.canGoBack).toBe(false);
    expect(nav?.payload.canGoForward).toBe(false);
    expect(String(nav?.payload.url)).toContain("/start");
  });

  it("reports a pushState route change and enables back", () => {
    const sent = runScript();
    history.pushState(null, "", "/next");
    const nav = navigations(sent).at(-1);
    expect(String(nav?.payload.url)).toContain("/next");
    expect(nav?.payload.canGoBack).toBe(true);
  });

  it("enables forward after a popstate takes the page back", async () => {
    const sent = runScript();
    history.pushState(null, "", "/a");
    // The bridge registered its popstate listener at install, so it has already
    // observed by the time this one resolves.
    const popped = new Promise<void>((resolve) => {
      window.addEventListener("popstate", () => resolve(), { once: true });
    });
    history.back();
    await popped;
    const nav = navigations(sent).at(-1);
    expect(String(nav?.payload.url)).toContain("/start");
    expect(nav?.payload.canGoBack).toBe(false);
    expect(nav?.payload.canGoForward).toBe(true);
  });

  it("reports the title once the document has parsed it", () => {
    vi.useFakeTimers();
    const sent = runScript();
    // Injected into <head>: <title> has not been parsed yet, so the opening
    // report cannot carry it.
    expect(navigations(sent).at(-1)?.payload.title).toBe("");

    document.title = "Dev Server";
    window.dispatchEvent(new Event("load"));
    expect(navigations(sent).at(-1)?.payload.title).toBe("Dev Server");

    // And a router that swaps the title without moving the page.
    document.title = "Dev Server — Settings";
    vi.advanceTimersByTime(300);
    expect(navigations(sent).at(-1)?.payload.title).toBe("Dev Server — Settings");
  });

  it("does not grow the stack on replaceState", () => {
    const sent = runScript();
    history.replaceState(null, "", "/replaced");
    history.replaceState(null, "", "/replaced-again");
    const reported = navigations(sent);
    const nav = reported.at(-1);
    expect(String(nav?.payload.url)).toContain("/replaced-again");
    // Three replaceState-shaped reports (initial + two replaces) that never
    // deepen the stack: a replace treated as a push would light canGoBack.
    expect(reported).toHaveLength(3);
    expect(reported.map((m) => m.payload.canGoBack)).toEqual([false, false, false]);
    expect(nav?.payload.canGoForward).toBe(false);
  });

  it("increments seq so the parent can drop stale messages", () => {
    const sent = runScript();
    history.pushState(null, "", "/a");
    history.pushState(null, "", "/b");
    const seqs = navigations(sent).map((m) => Number(m.payload.seq));
    // Length is the assertion that keeps the rest honest: sorted-and-unique is
    // vacuously true of a one-element array.
    expect(seqs).toHaveLength(3);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("stamps every message with the same docId", () => {
    const sent = runScript();
    history.pushState(null, "", "/a");
    const ids = new Set(sent.map((m) => String(m.payload.docId)));
    expect(sent.length).toBeGreaterThan(1);
    expect(ids.size).toBe(1);
    expect([...ids][0]).not.toBe("undefined");
  });

  it("navigates on a goto command from the parent", () => {
    runScript();
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign, href: window.location.href },
      writable: true,
    });
    command({ source: COMMAND_SOURCE, command: "goto", url: "http://localhost:3000/x" });
    expect(assign).toHaveBeenCalledWith("http://localhost:3000/x");
  });

  it("refuses a goto to anything but http or https", () => {
    runScript();
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign, href: window.location.href },
      writable: true,
    });
    const refused = [
      "javascript:alert(1)",
      // The URL parser lowercases the scheme and strips tabs and newlines, so
      // checking the parsed protocol catches obfuscation a prefix test misses.
      "JavaScript:alert(1)",
      "\tjava\nscript:alert(1)",
      "data:text/html,<script>1</script>",
      "file:///etc/passwd",
      // Unparseable even against a base: fail closed.
      "http://",
    ];
    // An exception thrown inside a message listener does not reach dispatchEvent,
    // but it does fire window.onerror — so this is how a refusal that throws
    // instead of returning becomes visible.
    const errors: ErrorEvent[] = [];
    const onError = (event: ErrorEvent): void => {
      errors.push(event);
    };
    window.addEventListener("error", onError);
    try {
      for (const url of refused) {
        command({ source: COMMAND_SOURCE, command: "goto", url });
      }
    } finally {
      window.removeEventListener("error", onError);
    }
    expect(assign).not.toHaveBeenCalled();
    expect(errors).toEqual([]);

    // The control: the refusals above have to be the scheme check, not a goto
    // handler that stopped working.
    command({ source: COMMAND_SOURCE, command: "goto", url: "https://example.test/ok" });
    expect(assign).toHaveBeenCalledWith("https://example.test/ok");
    // A relative path is resolved against the page and stays inside the
    // allowlist, so it is allowed.
    command({ source: COMMAND_SOURCE, command: "goto", url: "/relative" });
    expect(assign).toHaveBeenLastCalledWith("http://localhost:3000/relative");
  });

  it("goes back on a back command once there is somewhere to go", () => {
    runScript();
    history.pushState(null, "", "/deeper");
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    command({ source: COMMAND_SOURCE, command: "back" });
    expect(back).toHaveBeenCalled();
  });

  it("ignores a command from a window that is not the embedder", () => {
    runScript();
    history.pushState(null, "", "/deeper");
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    // A nested third-party frame — an ad, a checkout widget — can postMessage to
    // its embedder. It executes inside the preview origin, so nothing the parent
    // checks afterwards can tell the difference.
    const frame = document.createElement("iframe");
    document.body.append(frame);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: COMMAND_SOURCE, command: "back" },
        source: frame.contentWindow,
      }),
    );
    expect(back).not.toHaveBeenCalled();
  });

  it("ignores messages from an unknown source", () => {
    runScript();
    history.pushState(null, "", "/deeper");
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    command({ source: "somebody-else", command: "back" });
    expect(back).not.toHaveBeenCalled();
  });

  it("restores the saved stack when a same-origin document preceded this one", () => {
    // A real in-page navigation — a link click, a form post. The previous
    // document is still in this browsing context, so back has somewhere to go
    // and the saved stack is the only way to know that after the document swap.
    setReferrer("http://localhost:3000/previous");
    sessionStorage.setItem(
      "__paseo_nav",
      JSON.stringify({
        stack: ["http://localhost:3000/previous", "http://localhost:3000/start"],
        index: 1,
      }),
    );
    expect(navigations(runScript()).at(-1)?.payload.canGoBack).toBe(true);
  });

  it("ignores the saved stack when the embedder loaded this document", () => {
    // The app re-points the preview by remounting the iframe element, so this is
    // a fresh browsing context with no back entry — but sessionStorage is keyed
    // by origin, not by context, and still holds the previous one's stack.
    // Trusting it lights Back on a frame whose history.back() does nothing.
    setReferrer("http://localhost:8081/");
    sessionStorage.setItem(
      "__paseo_nav",
      JSON.stringify({
        stack: ["http://localhost:3000/one", "http://localhost:3000/two"],
        index: 1,
      }),
    );
    expect(navigations(runScript()).at(-1)?.payload.canGoBack).toBe(false);
  });

  it("survives sessionStorage being unavailable", () => {
    blockSessionStorage();
    let sent: BridgeMessage[] = [];
    expect(() => {
      sent = runScript();
    }).not.toThrow();
    expect(() => history.pushState(null, "", "/after-block")).not.toThrow();
    expect(String(navigations(sent).at(-1)?.payload.url)).toContain("/after-block");
  });

  it("replaces a previous instance instead of stacking a second one", () => {
    const sent = captureMessages();
    install();
    install();
    const before = sent.length;
    history.pushState(null, "", "/twice");
    // Two live instances would each patch history and each report the same
    // route change under their own seq counter.
    expect(navigations(sent.slice(before))).toHaveLength(1);
  });

  it("catches a location change that fires no event", () => {
    vi.useFakeTimers();
    const sent = runScript();
    const before = sent.length;
    // A router that writes location directly emits no popstate or hashchange;
    // the poll is the only thing that sees it.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, href: "http://localhost:3000/silent" },
      writable: true,
    });
    vi.advanceTimersByTime(300);
    expect(String(navigations(sent.slice(before)).at(-1)?.payload.url)).toContain("/silent");
  });

  it("goes quiet after destroy", () => {
    vi.useFakeTimers();
    const nativePushState = history.pushState;
    const nativeReplaceState = history.replaceState;
    const sent = runScript();
    expect(history.pushState).not.toBe(nativePushState);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const assign = vi.fn();

    window.__paseoNavigationBridge?.destroy();

    // Nothing of ours is left on the window: no handle, no poll, no patched
    // history, no command listener.
    expect(window.__paseoNavigationBridge).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(history.pushState).toBe(nativePushState);
    expect(history.replaceState).toBe(nativeReplaceState);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign, href: window.location.href },
      writable: true,
    });
    const before = sent.length;
    history.pushState(null, "", "/after-destroy");
    command({ source: COMMAND_SOURCE, command: "goto", url: "http://localhost:3000/nope" });
    vi.advanceTimersByTime(1000);
    expect(sent.slice(before)).toEqual([]);
    expect(assign).not.toHaveBeenCalled();
  });
});
