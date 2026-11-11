import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { Image } from "react-native";
import type { ViewportSize } from "@/components/zoomable-viewport/geometry";
import { createDaemonFileSession } from "@/file-panels/file/daemon-session";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import { useFilesFolderSwitcherAvailable } from "@/file-explorer/folders/recent-folders";
import { filesWorkspaceKey, useFilesViewStore } from "@/file-explorer/folders/view-store";
import { isSameFolder } from "@/file-explorer/folders/model";
import { buildWorkspaceExplorerStateKey } from "@/hooks/use-file-explorer-actions";
import { usePanelStore } from "@/stores/panel-store";
import { useSessionStore } from "@/stores/session-store";
import {
  GalleryImageCache,
  type GalleryImageState,
  type GalleryImageTarget,
  type LoadedGalleryImage,
} from "./image-cache";
import { resolveImageGallery, type ImageGallery } from "./model";

/** The gallery around the file tab's image, from the folder listing Files already holds. */
export function useImageGallery(input: {
  serverId: string;
  workspaceId: string;
  workspaceRoot: string;
  filePath: string;
}): ImageGallery | null {
  const { serverId, workspaceId, workspaceRoot, filePath } = input;
  const switcherAvailable = useFilesFolderSwitcherAvailable(serverId);
  const storedRoot = useFilesViewStore(
    (state) => state.rootByWorkspace[filesWorkspaceKey(serverId, workspaceId)] ?? null,
  );
  // The same root Files shows (see files-panel.tsx), so the order matches what the user browsed.
  const filesRoot = (switcherAvailable && storedRoot) || workspaceRoot;
  const outside = !isSameFolder(filesRoot, workspaceRoot);
  const stateKey = buildWorkspaceExplorerStateKey({
    workspaceId: outside ? null : workspaceId,
    workspaceRoot: filesRoot,
  });
  const directories = useSessionStore((state) =>
    stateKey ? state.sessions[serverId]?.fileExplorer.get(stateKey)?.directories : undefined,
  );
  const sortOption = usePanelStore((state) => state.explorerSortOption);
  const showHiddenFiles = usePanelStore((state) => state.explorerShowHiddenFiles);
  return useMemo(
    () =>
      resolveImageGallery({
        filePath,
        workspaceRoot,
        filesRoot,
        directories,
        sortOption,
        showHiddenFiles,
      }),
    [directories, filePath, filesRoot, showHiddenFiles, sortOption, workspaceRoot],
  );
}

// Only `createUrl` runs here; the features gate observing and writing.
const READ_ONLY_FEATURES = { workspaceFileEditing: false, fileByteWrites: false };

async function loadGalleryImage(target: GalleryImageTarget): Promise<LoadedGalleryImage> {
  const client = useSessionStore.getState().sessions[target.serverId]?.client;
  if (!client) throw new Error("The host is not connected.");
  const contents = await client.readFile(target.cwd, target.path);
  const session = createDaemonFileSession(client, READ_ONLY_FEATURES);
  const created = await session.createUrl({
    target,
    bytes: contents.bytes,
    mimeType: contents.mime,
  });
  return {
    url: created.url,
    version: contents.revision ?? `${contents.size}:${contents.modifiedAt}`,
    // Measuring decodes the image, so it is ready to draw when the gallery pages to it.
    size: await measureImage(created.url),
    release: created.release,
  };
}

function measureImage(url: string): Promise<ViewportSize | null> {
  return new Promise((resolve) => {
    Image.getSize(
      url,
      (width, height) => resolve(width > 0 && height > 0 ? { width, height } : null),
      () => resolve(null),
    );
  });
}

const galleryImages = new GalleryImageCache(loadGalleryImage);
const LOADING: GalleryImageState = { status: "loading" };

/**
 * One gallery image's URL, kept loaded while mounted. `version` is the file's observed version
 * when known; a newer one reloads the image.
 */
export function useGalleryImage(input: {
  serverId: string;
  workspaceRoot: string;
  targetPath: string | null;
  version: string | null;
}): GalleryImageState {
  const { serverId, workspaceRoot, targetPath, version } = input;
  const target = useMemo(
    () => (targetPath ? resolveFilePreviewReadTarget({ path: targetPath, workspaceRoot }) : null),
    [targetPath, workspaceRoot],
  );
  const key = target ? `${serverId}\u0000${target.cwd}\u0000${target.path}` : null;
  const cwd = target?.cwd ?? null;
  const path = target?.path ?? null;
  useEffect(() => {
    if (!key || !cwd || !path) return;
    return galleryImages.retain(key, { serverId, cwd, path }, version);
  }, [cwd, key, path, serverId, version]);
  const subscribe = useCallback(
    (listener: () => void) => (key ? galleryImages.subscribe(key, listener) : () => {}),
    [key],
  );
  const getSnapshot = useCallback(() => (key ? galleryImages.getState(key) : LOADING), [key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
