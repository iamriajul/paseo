import { PixelRatio } from "react-native";
import { useFetchQuery } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";

/** Requests in flight at once; the daemon renders one at a time and caches the rest. */
const MAX_CONCURRENT_THUMBNAILS = 4;
let running = 0;
const waiting: (() => void)[] = [];

async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_THUMBNAILS) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running += 1;
  try {
    return await task();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

/**
 * A data URI for an image's daemon-side thumbnail, sized for the tile on this screen. Keyed by
 * the entry's modified time, so an edited screenshot refreshes. `null` while loading or when
 * the host cannot make one; the tile shows the file-type icon instead.
 */
export function useFileThumbnail(input: {
  serverId: string;
  root: string;
  path: string;
  modifiedAt: string;
  tileEdge: number;
  enabled: boolean;
}): string | null {
  const client = useSessionStore((state) => state.sessions[input.serverId]?.client ?? null);
  const maxEdge = Math.ceil(input.tileEdge * PixelRatio.get());
  const query = useFetchQuery({
    queryKey: ["fileThumbnail", input.serverId, input.root, input.path, input.modifiedAt, maxEdge],
    queryFn: () =>
      limited(() => client!.getFileThumbnail({ cwd: input.root, path: input.path, maxEdge })),
    enabled: Boolean(client && input.enabled),
    dataShape: "value",
    // The key carries the file's modified time, so a cached thumbnail never goes stale.
    immutableWhen: () => true,
    gcTime: 5 * 60_000,
    retry: false,
  });
  return query.data ? `data:${query.data.mimeType};base64,${query.data.data}` : null;
}
