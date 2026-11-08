import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { normalizeFolderPath, type FilesGridSize, type FilesViewMode } from "./model";

const FilesViewPersistedSchema = z.object({
  rootByWorkspace: z.record(z.string(), z.string()),
  viewModeByFolder: z.record(z.string(), z.enum(["list", "grid"])),
  gridSize: z.enum(["small", "medium", "large"]),
});

interface FilesViewState extends z.infer<typeof FilesViewPersistedSchema> {
  /** `null` returns Files to the workspace itself. */
  setRoot: (workspaceKey: string, root: string | null) => void;
  setViewMode: (folderKey: string, mode: FilesViewMode) => void;
  setGridSize: (size: FilesGridSize) => void;
}

/** Per device: which folder Files shows, list or grid per folder, and the one grid size. */
export const useFilesViewStore = create<FilesViewState>()(
  persist(
    (set) => ({
      rootByWorkspace: {},
      viewModeByFolder: {},
      gridSize: "medium",
      setRoot: (workspaceKey, root) =>
        set((state) => {
          const rootByWorkspace = { ...state.rootByWorkspace };
          if (root) rootByWorkspace[workspaceKey] = root;
          else delete rootByWorkspace[workspaceKey];
          return { rootByWorkspace };
        }),
      setViewMode: (folderKey, mode) =>
        set((state) => ({ viewModeByFolder: { ...state.viewModeByFolder, [folderKey]: mode } })),
      setGridSize: (gridSize) => set({ gridSize }),
    }),
    {
      name: "files-view",
      version: 1,
      storage: createValidatedPersistStorage(AsyncStorage, FilesViewPersistedSchema),
      partialize: (state) => ({
        rootByWorkspace: state.rootByWorkspace,
        viewModeByFolder: state.viewModeByFolder,
        gridSize: state.gridSize,
      }),
    },
  ),
);

export function filesWorkspaceKey(serverId: string, workspaceId: string): string {
  return `${serverId}:${workspaceId}`;
}

export function filesFolderKey(serverId: string, folder: string): string {
  return `${serverId}:${normalizeFolderPath(folder)}`;
}

/** Points Files back at the workspace, before revealing something inside it. */
export function showWorkspaceInFiles(serverId: string, workspaceId: string | null | undefined) {
  if (!workspaceId) return;
  useFilesViewStore.getState().setRoot(filesWorkspaceKey(serverId, workspaceId), null);
}
