import type { TFunction } from "i18next";
import type { ComposerTrackPillSegment } from "@/composer/tracks";
import type { HeartbeatRow } from "./select";

export interface HeartbeatPillPresentation {
  segments: ComposerTrackPillSegment[];
  accessibilityLabel: string;
}

export function isActiveHeartbeat(row: HeartbeatRow): boolean {
  return row.kind === "provider" || row.status === "active";
}

export function buildHeartbeatPillPresentation(
  t: TFunction,
  rows: readonly HeartbeatRow[],
): HeartbeatPillPresentation {
  const label = t("heartbeats.headerCount", { count: rows.length });
  const hasActive = rows.some(isActiveHeartbeat);
  return {
    segments: [{ bucket: hasActive ? "running" : null, text: label }],
    accessibilityLabel: label,
  };
}
