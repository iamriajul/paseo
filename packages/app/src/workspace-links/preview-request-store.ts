import { create } from "zustand";

/**
 * A preview link names a workspace that may not be mounted yet. The link press
 * records the request here; the workspace screen opens the preview once it is
 * focused and knows its scripts, because only it owns the Browser that the
 * preview opens in (local or server-side).
 */
interface PreviewRequestState {
  pending: ReadonlySet<string>;
  request: (workspaceKey: string) => void;
  take: (workspaceKey: string) => boolean;
}

export const usePreviewRequestStore = create<PreviewRequestState>((set, get) => ({
  pending: new Set(),
  request: (workspaceKey) =>
    set((state) => ({ pending: new Set(state.pending).add(workspaceKey) })),
  take: (workspaceKey) => {
    if (!get().pending.has(workspaceKey)) {
      return false;
    }
    set((state) => {
      const pending = new Set(state.pending);
      pending.delete(workspaceKey);
      return { pending };
    });
    return true;
  },
}));

export function previewRequestKey(serverId: string, workspaceId: string): string {
  return `${serverId}:${workspaceId}`;
}

export function requestWorkspacePreview(serverId: string, workspaceId: string): void {
  usePreviewRequestStore.getState().request(previewRequestKey(serverId, workspaceId));
}
