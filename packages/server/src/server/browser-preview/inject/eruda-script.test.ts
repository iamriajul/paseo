// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ERUDA_CDN_URL, ERUDA_SCRIPT } from "./eruda-script.js";
import { BRIDGE_SOURCE, COMMAND_SOURCE } from "./protocol.js";

interface BridgeMessage {
  source: string;
  type: string;
  payload: Record<string, unknown>;
}

// No _isShow: eruda 3.4.3 has no such property. A fake that invents one lets a
// script that reads it pass here and fail in a real browser, which is what
// happened.
interface FakeEruda {
  _entryBtn: { _$el: Array<{ style: { display: string } }> };
  init: (options: unknown) => void;
  show: () => void;
  hide: () => void;
}

declare global {
  interface Window {
    eruda?: FakeEruda;
  }
}

// Unlike its two siblings the eruda script leaves no teardown handle, so an
// instance from an earlier test would answer this test's toggle as well. The
// listener it registers is the only way to take it back off the window.
const registered: Array<[string, EventListenerOrEventListenerObject]> = [];

function install(): void {
  const add = vi.spyOn(window, "addEventListener");
  const before = registered.length;
  try {
    new Function(ERUDA_SCRIPT)();
  } finally {
    for (const [type, handler] of add.mock.calls) {
      registered.push([type as string, handler as EventListenerOrEventListenerObject]);
    }
    add.mockRestore();
  }
  // The spy is the only thing keeping instances from leaking between tests. If
  // it ever stops intercepting — the failure mode this repo hits with jsdom
  // built-ins under vitest — every later test would quietly run against a pile
  // of live listeners, so fail loudly here instead.
  expect(registered.length).toBeGreaterThan(before);
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

function toggle(): void {
  command({ source: COMMAND_SOURCE, command: "toggle-eruda" });
}

function tags(): HTMLScriptElement[] {
  return [...document.querySelectorAll<HTMLScriptElement>("script")];
}

function fakeEruda(): { eruda: FakeEruda; entry: { style: { display: string } } } {
  const entry = { style: { display: "" } };
  const eruda: FakeEruda = {
    _entryBtn: { _$el: [entry] },
    init: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
  };
  window.eruda = eruda;
  return { eruda, entry };
}

// jsdom does not fetch a script's src, so nothing fires on its own.
function finishLoad(): void {
  const tag = tags().at(-1);
  expect(tag?.src).toBe(ERUDA_CDN_URL);
  tag?.dispatchEvent(new Event("load"));
}

function failLoad(): void {
  tags().at(-1)?.dispatchEvent(new Event("error"));
}

describe("ERUDA_SCRIPT", () => {
  afterEach(() => {
    for (const [type, handler] of registered) {
      window.removeEventListener(type, handler);
    }
    registered.length = 0;
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    delete window.eruda;
    vi.restoreAllMocks();
  });

  it("loads nothing until the parent asks for devtools", () => {
    runScript();
    expect(tags()).toHaveLength(0);
  });

  it("fetches eruda from the pinned CDN build on the first toggle", () => {
    runScript();
    toggle();
    expect(tags().map((tag) => tag.src)).toEqual([ERUDA_CDN_URL]);
  });

  it("ignores a toggle from a window that is not the embedder", () => {
    runScript();
    // A nested third-party frame — an ad, a checkout widget — can postMessage
    // to its embedder. It executes inside the preview origin, so nothing the
    // parent checks afterwards can tell the difference.
    const frame = document.createElement("iframe");
    document.body.append(frame);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: COMMAND_SOURCE, command: "toggle-eruda" },
        source: frame.contentWindow,
      }),
    );
    expect(tags().filter((tag) => tag.src === ERUDA_CDN_URL)).toHaveLength(0);
  });

  it("ignores messages from an unknown source and commands it does not own", () => {
    runScript();
    command({ source: "somebody-else", command: "toggle-eruda" });
    command({ source: COMMAND_SOURCE, command: "reload" });
    command({ source: COMMAND_SOURCE });
    expect(tags()).toHaveLength(0);

    // The control: the refusals above have to be the guards, not a toggle
    // handler that stopped working.
    toggle();
    expect(tags()).toHaveLength(1);
  });

  it("announces eruda-ready and hides the floating entry button", () => {
    const sent = runScript();
    const { eruda, entry } = fakeEruda();
    toggle();
    finishLoad();
    expect(eruda.init).toHaveBeenCalledWith({ defaults: { theme: "Dark" } });
    // The Paseo toolbar owns the toggle; eruda's own button would be a second
    // control for the same thing, sitting on top of the previewed page.
    expect(entry.style.display).toBe("none");
    const ready = sent.filter((message) => message.type === "eruda-ready");
    expect(ready).toHaveLength(1);
    expect(ready[0]?.source).toBe(BRIDGE_SOURCE);
  });

  it("shows devtools on the toggle that loaded it and hides on the next", () => {
    runScript();
    const { eruda } = fakeEruda();
    toggle();
    finishLoad();
    expect(eruda.show).toHaveBeenCalledTimes(1);
    expect(eruda.hide).toHaveBeenCalledTimes(1); // the hide() inside init
    toggle();
    expect(eruda.hide).toHaveBeenCalledTimes(2);
    expect(eruda.show).toHaveBeenCalledTimes(1);
    toggle();
    expect(eruda.show).toHaveBeenCalledTimes(2);
    expect(eruda.hide).toHaveBeenCalledTimes(2);
    // Re-fetching a 1.4 MB bundle on every toggle is the regression here.
    expect(tags()).toHaveLength(1);
  });

  it("reports eruda-failed when the CDN build does not load", () => {
    const sent = runScript();
    toggle();
    failLoad();
    expect(sent.map((message) => message.type)).toEqual(["eruda-failed"]);
    expect(sent[0]?.source).toBe(BRIDGE_SOURCE);
  });

  it("reports eruda-failed when the bundle loads but defines no eruda", () => {
    const sent = runScript();
    // A CDN that answers 200 with something that is not the eruda bundle: the
    // transport succeeded, so onerror never fires.
    toggle();
    finishLoad();
    expect(sent.map((message) => message.type)).toEqual(["eruda-failed"]);
    // And the toggle is not wedged for the life of the document.
    toggle();
    expect(tags()).toHaveLength(2);
  });

  it("reports eruda-failed when init throws on the loaded bundle", () => {
    const sent = runScript();
    const { eruda } = fakeEruda();
    // Wrong build, blocked API, version skew — init throws out of the onload
    // handler, so nothing downstream of it runs unless the throw is caught.
    eruda.init = vi.fn(() => {
      throw new Error("wrong build");
    });
    toggle();
    finishLoad();
    expect(sent.map((message) => message.type)).toEqual(["eruda-failed"]);
    expect(eruda.show).not.toHaveBeenCalled();
    toggle();
    expect(tags()).toHaveLength(2);
  });

  it("retries the fetch after a failure", () => {
    runScript();
    toggle();
    failLoad();
    toggle();
    expect(tags()).toHaveLength(2);
  });

  it("does not start a second fetch while the first is in flight", () => {
    runScript();
    toggle();
    toggle();
    toggle();
    expect(tags()).toHaveLength(1);
  });
});
