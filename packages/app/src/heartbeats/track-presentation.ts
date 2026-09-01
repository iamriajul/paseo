import type { TFunction } from "i18next";
import type { ComposerTrackPillSegment } from "@/composer/tracks";
import { formatNextRun } from "@/utils/schedule-format";
import type { HeartbeatRow } from "./select";

export interface HeartbeatPillPresentation {
  segments: ComposerTrackPillSegment[];
  accessibilityLabel: string;
}

export function isActiveHeartbeat(row: HeartbeatRow): boolean {
  return row.kind === "provider" || row.status === "active";
}

/**
 * The pill stays compact: one lead number and a short time ("in 3m") or "paused". The panel
 * behind it carries the per-row detail, so the pill only has to answer "is anything coming up".
 * No status mark — heartbeats never read as "running" in the bar.
 */
export function buildHeartbeatPillPresentation(
  t: TFunction,
  rows: readonly HeartbeatRow[],
): HeartbeatPillPresentation {
  const nextRun = earliestNextRun(rows);
  const text = nextRun ?? t("heartbeats.pillPaused", { count: rows.length });
  const accessibilityLabel = nextRun
    ? t("heartbeats.pillNextRunAccessible", { count: rows.length, when: nextRun })
    : t("heartbeats.pillPausedAccessible", { count: rows.length });
  return {
    segments: [{ bucket: null, text }],
    accessibilityLabel,
  };
}

/** The soonest known next run across rows, as a short "in 3m" string. Null when none is known. */
function earliestNextRun(rows: readonly HeartbeatRow[]): string | null {
  let earliestMs = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (row.kind !== "paseo" || row.status !== "active" || !row.nextRunAt) continue;
    const time = new Date(row.nextRunAt).getTime();
    if (!Number.isNaN(time) && time < earliestMs) {
      earliestMs = time;
    }
  }
  if (earliestMs === Number.POSITIVE_INFINITY) {
    return null;
  }
  return formatNextRun(new Date(earliestMs).toISOString());
}
