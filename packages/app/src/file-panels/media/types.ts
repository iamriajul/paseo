import type { PluginFile } from "@getpaseo/plugin/client";
import type { MediaFormat } from "./formats";

export interface MediaPlayerProps {
  format: MediaFormat;
  /** The file's size when this player mounted; the panel remounts it when the file changes. */
  size: number;
  serverId: string;
  workspaceId: string;
  path: string;
  /** For web pages without a service worker, which play the file from memory. */
  file: PluginFile;
  label: string;
}
