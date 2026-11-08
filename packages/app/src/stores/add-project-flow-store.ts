import { create } from "zustand";

export interface AddProjectFlowRequest {
  id: number;
  preferredHostId?: string;
  /**
   * Reuse the flow's directory search as a plain folder picker on one host: no host choice,
   * and choosing a folder hands its path back instead of adding a project.
   */
  pickFolder?: { serverId: string; onPick: (path: string) => void };
}

interface AddProjectFlowStoreState {
  request: AddProjectFlowRequest | null;
  open: (preferredHostId?: string) => void;
  openFolderPicker: (serverId: string, onPick: (path: string) => void) => void;
  close: () => void;
}

let nextRequestId = 1;

export const useAddProjectFlowStore = create<AddProjectFlowStoreState>((set) => ({
  request: null,
  open: (preferredHostId) => {
    set({
      request: {
        id: nextRequestId++,
        ...(preferredHostId ? { preferredHostId } : {}),
      },
    });
  },
  openFolderPicker: (serverId, onPick) => {
    set({ request: { id: nextRequestId++, pickFolder: { serverId, onPick } } });
  },
  close: () => set({ request: null }),
}));
