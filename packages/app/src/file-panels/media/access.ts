import { useMemo } from "react";
import type { DownloadStreamOptions } from "@getpaseo/client/internal/daemon-client";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import type { OpenByteRange } from "./range-reader";

/** Whether this host can stream the file's bytes in ranges, and the opener when it can. */
export type MediaAccess =
  | { status: "ready"; open: OpenByteRange }
  | { status: "update-host" }
  | { status: "unavailable" };

/**
 * Byte-range reads of the panel's file over the session, the same target the file tab reads,
 * so relay, SSH and socket hosts stream like direct ones. `readAhead` sets how much each open
 * download keeps in flight: a seek discards it, a whole-file load wants more of it.
 */
export function useMediaAccess(input: {
  serverId: string;
  workspaceId: string;
  path: string;
  readAhead: Pick<DownloadStreamOptions, "sliceBytes" | "depth">;
}): MediaAccess {
  const { serverId, workspaceId, path } = input;
  const { sliceBytes, depth } = input.readAhead;
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  // COMPAT(downloadRange): added in v0.15.919, drop gate after 2027-05-14.
  const ranges = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.downloadRange === true,
  );
  const workspaceRoot = useWorkspaceDirectory(serverId, workspaceId);
  return useMemo(() => {
    const target = resolveFilePreviewReadTarget({
      path,
      workspaceRoot: workspaceRoot ?? undefined,
    });
    if (!client || !target) return { status: "unavailable" };
    if (!ranges) return { status: "update-host" };
    const open: OpenByteRange = async (range, signal) => {
      const stream = await client.openDownloadStream(
        {
          cwd: target.cwd,
          path: target.path,
          kind: "file",
          offset: range.start,
          length: range.end - range.start + 1,
        },
        { signal, sliceBytes, depth },
      );
      return stream.chunks;
    };
    return { status: "ready", open };
  }, [client, depth, path, ranges, sliceBytes, workspaceRoot]);
}
