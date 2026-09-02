/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The pane's own wiring, which no other test in this directory reaches: the
// reducer, the bridge client and the URL helpers each have their own suite, but
// the rules that only exist here — that a `load` with no announcement behind it
// ends the bridge session, that an announced one does not, and that neither
// re-points the frame — are the pane's alone.

const { toolbarProps, noticeRenders, addWorkspaceAttachment } = vi.hoisted(() => ({
  toolbarProps: [] as Record<string, unknown>[],
  noticeRenders: { count: 0 },
  addWorkspaceAttachment: vi.fn(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Stubbed so this test is about the pane's state machine and not about the
// toolbar's icons, menus and tooltips. Recording the props is the point: they
// are the whole contract between the two.
vi.mock("./web-toolbar", () => ({
  WebBrowserToolbar: (props: Record<string, unknown>) => {
    toolbarProps.push(props);
    return null;
  },
}));

vi.mock("./web-notice", () => ({
  WebBrowserNotice: () => {
    noticeRenders.count += 1;
    return null;
  },
}));

vi.mock("./web-annotation-composer", () => ({
  WebAnnotationComposer: () => null,
}));

vi.mock("@/attachments/workspace-attachments-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useWorkspaceAttachmentsStore: (selector: (state: unknown) => unknown) =>
    selector({ addWorkspaceAttachment }),
}));

vi.mock("@/desktop/browser/workspace-browser-preview", async (importOriginal) => ({
  // buildBrowserPreviewUrl stays real: it is what turns the record's loopback
  // URL into the origin this test then has to match on inbound messages.
  ...(await importOriginal<Record<string, unknown>>()),
  useBrowserPreviewTemplate: () => TEMPLATE,
}));

import { useBrowserStore } from "@/desktop/browser/store";
import { WebBrowserPane } from "./web-pane";

const TEMPLATE = "http://{port}.preview.test";
const PREVIEW_ORIGIN = "http://3000.preview.test";
const START_URL = "http://localhost:3000/";

let container: HTMLDivElement;
let root: Root;
// Delegates to the real store action. `applyBrowserPatch` collapses a patch
// whose values already match, so a redundant write is invisible in the record
// itself — the call is the only place it shows.
let updateBrowser: ReturnType<typeof vi.fn>;

function lastToolbarProps(): Record<string, unknown> {
  const props = toolbarProps.at(-1);
  if (!props) throw new Error("the toolbar never rendered");
  return props;
}

function toolbarState(): { displayUrl: string; canGoBack: boolean; canGoForward: boolean } {
  return lastToolbarProps().state as {
    displayUrl: string;
    canGoBack: boolean;
    canGoForward: boolean;
  };
}

function frame(): HTMLIFrameElement {
  const iframe = container.querySelector("iframe");
  if (!iframe) throw new Error("the pane rendered no iframe");
  return iframe;
}

/** A message from the injected script, authentic on both of the bridge's checks. */
function postFromFrame(type: string, payload: unknown): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "paseo-browser-bridge", type, payload },
        origin: PREVIEW_ORIGIN,
        source: frame().contentWindow,
      }),
    );
  });
}

function announce(docId: string): void {
  postFromFrame("ready", { docId });
}

function reportNavigation(input: {
  docId: string;
  seq: number;
  url: string;
  title?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
}): void {
  postFromFrame("navigation", {
    title: "",
    canGoBack: false,
    canGoForward: false,
    ...input,
  });
}

/** What the browser fires on the element when the frame finishes a document. */
function fireFrameLoad(): void {
  act(() => {
    frame().dispatchEvent(new Event("load"));
  });
}

function renderPane(browserId: string): void {
  act(() => {
    root.render(
      <WebBrowserPane browserId={browserId} serverId="server-1" workspaceId="ws-1" cwd="/tmp" />,
    );
  });
}

function createBrowser(initialUrl: string): string {
  return useBrowserStore.getState().createBrowser({ initialUrl });
}

beforeEach(() => {
  // expo/tsconfig.base sets `jsx: "react-native"`, so esbuild emits classic
  // `React.createElement` and every rendered component needs React in scope.
  // Same reason as components/rename-modal.test.tsx.
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  toolbarProps.length = 0;
  noticeRenders.count = 0;
  const realUpdateBrowser = useBrowserStore.getState().updateBrowser;
  updateBrowser = vi.fn(realUpdateBrowser);
  useBrowserStore.setState({
    browsersById: {},
    updateBrowser: updateBrowser as typeof realUpdateBrowser,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("WebBrowserPane bridge liveness", () => {
  it("keeps the bridge alive across the load of the document that announced itself", () => {
    const browserId = createBrowser(START_URL);
    renderPane(browserId);

    // The real order: the script is injected into <head>, so it announces while
    // the document is still parsing and `load` arrives afterwards.
    announce("doc-1");
    expect(lastToolbarProps().bridgeAvailable).toBe(true);

    fireFrameLoad();

    expect(lastToolbarProps().bridgeAvailable).toBe(true);
    expect(noticeRenders.count).toBe(0);
  });

  // The hole this test exists for: an ordinary click on an off-origin link
  // navigates the frame away, `event.origin` stops matching and nothing ever
  // arrives again. Before the fix the pane went on offering devtools, an
  // element picker and a history that belonged to a page it had left.
  it("ends the bridge session on a load that nothing announced", () => {
    const browserId = createBrowser(START_URL);
    renderPane(browserId);

    announce("doc-1");
    reportNavigation({
      docId: "doc-1",
      seq: 1,
      url: `${PREVIEW_ORIGIN}/deep`,
      title: "Deep",
      canGoBack: true,
      canGoForward: true,
    });
    fireFrameLoad();
    expect(lastToolbarProps().bridgeAvailable).toBe(true);
    expect(toolbarState().canGoBack).toBe(true);

    act(() => (lastToolbarProps().onToggleEruda as () => void)());
    expect(lastToolbarProps().isErudaOpen).toBe(true);

    // The off-origin document loads. It carries no injected script, so there is
    // no announcement in front of it.
    fireFrameLoad();

    expect(lastToolbarProps().bridgeAvailable).toBe(false);
    // The panel went with the document. Leaving the mirror set would render the
    // devtools control disabled and lit at the same time.
    expect(lastToolbarProps().isErudaOpen).toBe(false);
    // Not merely disabled: the page's history went with the page, so the
    // parent's own stack — one entry — is what back and forward now answer to.
    expect(toolbarState().canGoBack).toBe(false);
    expect(toolbarState().canGoForward).toBe(false);
    expect(toolbarState().displayUrl).toBe(START_URL);
    expect(noticeRenders.count).toBeGreaterThan(0);
  });

  it("leaves the frame where it is when the bridge is lost", () => {
    const browserId = createBrowser(START_URL);
    renderPane(browserId);
    announce("doc-1");
    const before = frame();

    fireFrameLoad();
    fireFrameLoad();

    // Re-pointing the src would yank the user off the page they just opened.
    expect(lastToolbarProps().bridgeAvailable).toBe(false);
    expect(frame()).toBe(before);
    expect(before.getAttribute("src")).toBe(`${PREVIEW_ORIGIN}/`);
  });

  it("writes the fallback url and clears the title on the record", () => {
    const browserId = createBrowser(START_URL);
    renderPane(browserId);
    announce("doc-1");
    reportNavigation({ docId: "doc-1", seq: 1, url: `${PREVIEW_ORIGIN}/deep`, title: "Deep" });
    fireFrameLoad();
    expect(useBrowserStore.getState().browsersById[browserId]?.title).toBe("Deep");

    fireFrameLoad();

    // The tab label, tooltip and persisted url all read from the record, and on
    // this path nothing ever corrects it.
    const record = useBrowserStore.getState().browsersById[browserId];
    expect(record?.url).toBe(START_URL);
    expect(record?.title).toBe("");
  });

  // Each document announces once, so consuming one announcement per load is
  // what keeps a long-lived SPA from banking credit for a later navigation.
  it("ends the session on the load after a same-origin route change", () => {
    const browserId = createBrowser(START_URL);
    renderPane(browserId);
    announce("doc-1");
    fireFrameLoad();

    // An in-page route change: a `navigation` message, no new document.
    reportNavigation({ docId: "doc-1", seq: 2, url: `${PREVIEW_ORIGIN}/about` });
    expect(lastToolbarProps().bridgeAvailable).toBe(true);

    fireFrameLoad();

    expect(lastToolbarProps().bridgeAvailable).toBe(false);
  });

  it("recovers when the frame returns to a page the bridge is in", () => {
    const browserId = createBrowser(START_URL);
    renderPane(browserId);
    announce("doc-1");
    fireFrameLoad();
    fireFrameLoad();
    expect(lastToolbarProps().bridgeAvailable).toBe(false);
    const noticesWhileLost = noticeRenders.count;
    expect(noticesWhileLost).toBeGreaterThan(0);

    // Back on the preview origin — a fresh document, so a fresh announcement.
    announce("doc-2");

    expect(lastToolbarProps().bridgeAvailable).toBe(true);
    const noticesAfterRecovery = noticeRenders.count;
    fireFrameLoad();
    expect(lastToolbarProps().bridgeAvailable).toBe(true);
    // The notice is gone rather than merely stale: nothing rendered it again.
    expect(noticeRenders.count).toBe(noticesAfterRecovery);
  });

  // A direct URL never had a bridge, and every page it loads arrives here. The
  // reducer has to treat that as nothing happening, or the pane republishes the
  // record on every load.
  it("does not touch the record when a direct url loads", () => {
    const browserId = createBrowser("https://example.com/");
    renderPane(browserId);
    updateBrowser.mockClear();

    fireFrameLoad();
    fireFrameLoad();

    expect(updateBrowser).not.toHaveBeenCalled();
    expect(lastToolbarProps().bridgeAvailable).toBe(false);
  });
});
