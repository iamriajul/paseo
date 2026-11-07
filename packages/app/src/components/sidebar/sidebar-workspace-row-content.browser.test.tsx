import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { BackgroundTaskDescriptorPayload } from "@getpaseo/protocol/messages";
import { useBackgroundTaskStore } from "@/background-tasks/store";
import { createSidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { seedSessionWorkspaces } from "@/test/seed-session";
import { SidebarWorkspaceRowContent } from "./sidebar-workspace-row-content";

// The row's menus reach the toast host, which imports `ToastAndroid`; react-native-web has none.
vi.mock("@/components/toast-host", () => ({
  useToastHost: () => ({ api: {}, toast: null, dismiss: () => {} }),
  ToastViewport: () => null,
}));

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

const SERVER_ID = "row-background-task";
const WORKSPACE_ID = "ws-background";
const AGENT_ID = "agent-background";

const descriptor: WorkspaceDescriptor = {
  createdAt: null,
  lastUserMessageAt: null,
  id: WORKSPACE_ID,
  projectId: "project-background",
  projectDisplayName: "Project",
  projectRootPath: "/repo/project-background",
  workspaceDirectory: "/repo/project-background/ws-background",
  projectKind: "git",
  workspaceKind: "worktree",
  name: "feature",
  status: "done",
  statusEnteredAt: null,
  archivingAt: null,
  diffStat: null,
  scripts: [],
};

const runningTask: BackgroundTaskDescriptorPayload = {
  taskId: "task-1",
  parentAgentId: AGENT_ID,
  type: "bash",
  description: "npm run dev",
  status: "running",
  updatedAt: "2026-11-07T00:00:00.000Z",
};

const mounted: { root: Root; container: HTMLDivElement }[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  useBackgroundTaskStore.setState({ tasks: new Map() });
});

function seedWorkspaceWithRunningBackgroundTask(): void {
  useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
  seedSessionWorkspaces(SERVER_ID, new Map([[WORKSPACE_ID, descriptor]]));
  useSessionStore.setState((state) => {
    const session = state.sessions[SERVER_ID];
    if (!session) throw new Error("initializeSession did not create the session");
    return {
      sessions: {
        ...state.sessions,
        [SERVER_ID]: {
          ...session,
          workspaceAgentActivity: new Map([
            [WORKSPACE_ID, { agentId: AGENT_ID, status: "done", enteredAt: null }],
          ]),
        },
      },
    };
  });
  useBackgroundTaskStore.getState().replaceList(SERVER_ID, AGENT_ID, [runningTask]);
}

function mountRow(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient();
  const workspace = createSidebarWorkspaceEntry({ serverId: SERVER_ID, workspace: descriptor });
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <SidebarWorkspaceRowContent
          workspace={workspace}
          backdrop="surfaceSidebar"
          isHovered={false}
          isLoading={false}
        />
      </QueryClientProvider>,
    ),
  );
  mounted.push({ root, container });
  return container;
}

describe("SidebarWorkspaceRowContent on web", () => {
  it("turns the background-task ring with a Web Animation", () => {
    seedWorkspaceWithRunningBackgroundTask();
    const container = mountRow();

    const indicator = container.querySelector(
      '[data-testid="workspace-status-indicator-background-running"]',
    );
    expect(indicator).toBeInstanceOf(HTMLElement);
    const running = (indicator as HTMLElement)
      .getAnimations({ subtree: true })
      .filter((animation) => animation.playState === "running");
    expect(running).toHaveLength(1);
  });
});
