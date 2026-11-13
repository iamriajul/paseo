import { describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import {
  collectAllTabs,
  createWorkspaceLayoutStore,
  findPaneContainingTab,
  type WorkspaceTabSnapshot,
} from "@/stores/workspace-layout-store";
import { buildWorkspaceTabMenuEntries } from "@/screens/workspace/workspace-tab-menu";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

const WORKSPACE = "server-1:ws-main";

function memoryStorage(): StateStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      values.set(name, value);
    },
    removeItem: (name) => {
      values.delete(name);
    },
  };
}

async function createStore(storage = memoryStorage()) {
  const store = createWorkspaceLayoutStore(undefined, storage);
  await store.persist.rehydrate();
  return store;
}

type Store = Awaited<ReturnType<typeof createStore>>;

function open(store: Store, target: WorkspaceTabTarget): string {
  const tabId = store.getState().openTab({ workspaceKey: WORKSPACE, target, intent: "reveal" });
  if (!tabId) throw new Error("tab did not open");
  return tabId;
}

function tabIds(store: Store): string[] {
  const layout = store.getState().layoutByWorkspace[WORKSPACE];
  return layout ? collectAllTabs(layout.root).map((tab) => tab.tabId) : [];
}

function snapshot(input: { agents: string[]; terminals: string[] }): WorkspaceTabSnapshot {
  return {
    agentsHydrated: true,
    terminalsHydrated: true,
    activeAgentIds: input.agents,
    autoOpenAgentIds: [],
    knownTerminalIds: input.terminals,
    standaloneTerminalIds: [],
  };
}

describe("pinned workspace tabs", () => {
  it("refuses to close a pinned tab and closes it once unpinned", async () => {
    const store = await createStore();
    const file = open(store, { kind: "file", path: "notes.md" });

    store.getState().setTabPinned(WORKSPACE, file, true);
    store.getState().closeTab(WORKSPACE, file);
    expect(tabIds(store)).toContain(file);

    store.getState().setTabPinned(WORKSPACE, file, false);
    store.getState().closeTab(WORKSPACE, file);
    expect(tabIds(store)).not.toContain(file);
  });

  it("does not pin a tab that is not in the layout", async () => {
    const store = await createStore();
    store.getState().setTabPinned(WORKSPACE, "missing", true);
    expect(store.getState().pinnedTabIdsByWorkspace[WORKSPACE]).toBeUndefined();
  });

  it("keeps a pinned tab whose agent was archived or whose terminal is gone", async () => {
    const store = await createStore();
    const pinnedAgent = open(store, { kind: "agent", agentId: "agent-pinned" });
    const plainAgent = open(store, { kind: "agent", agentId: "agent-plain" });
    const pinnedTerminal = open(store, { kind: "terminal", terminalId: "term-pinned" });
    const plainTerminal = open(store, { kind: "terminal", terminalId: "term-plain" });
    store.getState().setTabPinned(WORKSPACE, pinnedAgent, true);
    store.getState().setTabPinned(WORKSPACE, pinnedTerminal, true);
    // The explicit open keeps an agent visible while archived; drop that to model a real archive.
    store.getState().unpinAgent(WORKSPACE, "agent-pinned");
    store.getState().unpinAgent(WORKSPACE, "agent-plain");

    store.getState().reconcileTabs(WORKSPACE, snapshot({ agents: [], terminals: [] }));

    expect(tabIds(store)).toEqual(expect.arrayContaining([pinnedAgent, pinnedTerminal]));
    expect(tabIds(store)).not.toContain(plainAgent);
    expect(tabIds(store)).not.toContain(plainTerminal);
    expect(store.getState().pinnedTabIdsByWorkspace[WORKSPACE]).toEqual(
      new Set([pinnedAgent, pinnedTerminal]),
    );
  });

  it("keeps a pane open while it holds a pinned tab", async () => {
    const store = await createStore();
    open(store, { kind: "file", path: "a.md" });
    const pinned = open(store, { kind: "file", path: "b.md" });
    const paneId = store.getState().splitPane(WORKSPACE, {
      tabId: pinned,
      targetPaneId: findPaneContainingTab(
        store.getState().layoutByWorkspace[WORKSPACE]!.root,
        pinned,
      )!.id,
      position: "right",
    });
    expect(paneId).toBeTruthy();
    store.getState().setTabPinned(WORKSPACE, pinned, true);

    store.getState().closePane(WORKSPACE, paneId!);
    expect(tabIds(store)).toContain(pinned);

    store.getState().setTabPinned(WORKSPACE, pinned, false);
    store.getState().closePane(WORKSPACE, paneId!);
    expect(tabIds(store)).not.toContain(pinned);
  });

  it("moves the pin with a draft that becomes its agent", async () => {
    const store = await createStore();
    const draft = open(store, { kind: "draft", draftId: "draft-1" });
    store.getState().setTabPinned(WORKSPACE, draft, true);

    const agentTab = store.getState().convertDraftToAgent(WORKSPACE, draft, "agent-1");

    expect(agentTab).toBeTruthy();
    expect(agentTab).not.toBe(draft);
    expect(store.getState().pinnedTabIdsByWorkspace[WORKSPACE]).toEqual(new Set([agentTab]));
  });

  it("restores pins after a reload, server browser tabs included", async () => {
    const storage = memoryStorage();
    const store = await createStore(storage);
    const file = open(store, { kind: "file", path: "notes.md" });
    const serverTab = open(store, { kind: "server_browser", browserId: "browser-1" });
    store.getState().setTabPinned(WORKSPACE, file, true);

    const restored = await createStore(storage);

    expect(tabIds(restored)).toEqual(expect.arrayContaining([file, serverTab]));
    expect(restored.getState().pinnedTabIdsByWorkspace[WORKSPACE]).toEqual(new Set([file]));
    restored.getState().closeTab(WORKSPACE, file);
    expect(tabIds(restored)).toContain(file);
  });

  it("forgets a workspace's pins when the workspace is purged", async () => {
    const store = await createStore();
    const file = open(store, { kind: "file", path: "notes.md" });
    store.getState().setTabPinned(WORKSPACE, file, true);
    store.getState().purgeWorkspace(WORKSPACE);
    expect(store.getState().pinnedTabIdsByWorkspace[WORKSPACE]).toBeUndefined();
  });
});

describe("pinned tab menu", () => {
  const noop = () => {};
  function entries(input: { pinned: boolean; canPin: boolean }) {
    return buildWorkspaceTabMenuEntries({
      surface: "desktop",
      tab: {
        key: "file:notes.md",
        tabId: "file:notes.md",
        kind: "file",
        target: { kind: "file", path: "notes.md" },
      },
      index: 0,
      tabCount: 2,
      menuTestIDBase: "menu",
      onCopyResumeCommand: noop,
      onCopyAgentId: noop,
      onCopyTerminalId: noop,
      onCopyFilePath: noop,
      onReloadAgent: noop,
      onRenameTab: noop,
      onCloseTab: noop,
      onCloseTabsBefore: noop,
      onCloseTabsAfter: noop,
      onCloseOtherTabs: noop,
      pinned: input.pinned,
      ...(input.canPin ? { onTogglePin: noop } : {}),
    }).flatMap((entry) => (entry.kind === "item" ? [entry] : []));
  }

  it("offers Unpin and turns Close off for a pinned tab", () => {
    const items = entries({ pinned: true, canPin: true });
    expect(items.find((item) => item.key === "pin")?.testID).toBe("menu-unpin");
    expect(items.find((item) => item.key === "close")?.disabled).toBe(true);
  });

  it("offers Pin and keeps Close on for an unpinned tab", () => {
    const items = entries({ pinned: false, canPin: true });
    expect(items.find((item) => item.key === "pin")?.testID).toBe("menu-pin");
    expect(items.find((item) => item.key === "close")?.disabled).toBeFalsy();
  });

  it("has no pin entry when the tab cannot be pinned", () => {
    expect(entries({ pinned: false, canPin: false }).some((item) => item.key === "pin")).toBe(
      false,
    );
  });
});
