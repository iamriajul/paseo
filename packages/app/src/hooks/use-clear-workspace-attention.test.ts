import { beforeEach, describe, expect, it, vi } from "vitest";

const mockClient = {
  clearWorkspaceAttention: vi.fn().mockResolvedValue(undefined),
  markWorkspaceUnread: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getClient: (id: string) => (id === "test-server" ? mockClient : null),
  }),
}));

import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { selectWorkspaceAttentionStatus } from "./use-clear-workspace-attention";

const WORKSPACE_ID = "test-ws-1";

describe("selectWorkspaceAttentionStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("evaluates attention status as clearable and not unreadable", () => {
    const result = selectWorkspaceAttentionStatus("attention");
    expect(result.hasClearableAttention).toBe(true);
    expect(result.canMarkUnread).toBe(false);
  });

  it("evaluates failed status as clearable and not unreadable", () => {
    const result = selectWorkspaceAttentionStatus("failed");
    expect(result.hasClearableAttention).toBe(true);
    expect(result.canMarkUnread).toBe(false);
  });

  it("evaluates done status (marked as read) as not clearable and markable as unread", () => {
    const result = selectWorkspaceAttentionStatus("done");
    expect(result.hasClearableAttention).toBe(false);
    expect(result.canMarkUnread).toBe(true);
  });

  it("evaluates running and needs_input statuses as neither clearable nor markable as unread", () => {
    const running = selectWorkspaceAttentionStatus("running");
    expect(running.hasClearableAttention).toBe(false);
    expect(running.canMarkUnread).toBe(false);

    const needsInput = selectWorkspaceAttentionStatus("needs_input");
    expect(needsInput.hasClearableAttention).toBe(false);
    expect(needsInput.canMarkUnread).toBe(false);
  });

  it("handles undefined status gracefully", () => {
    const result = selectWorkspaceAttentionStatus(undefined);
    expect(result.hasClearableAttention).toBe(false);
    expect(result.canMarkUnread).toBe(false);
  });
});

describe("useClearWorkspaceAttention actions", () => {
  it("dispatches clearWorkspaceAttention through host runtime client", async () => {
    const client = getHostRuntimeStore().getClient("test-server");
    await client?.clearWorkspaceAttention(WORKSPACE_ID);
    expect(mockClient.clearWorkspaceAttention).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it("dispatches markWorkspaceUnread through host runtime client", async () => {
    const client = getHostRuntimeStore().getClient("test-server");
    await client?.markWorkspaceUnread(WORKSPACE_ID);
    expect(mockClient.markWorkspaceUnread).toHaveBeenCalledWith(WORKSPACE_ID);
  });
});
