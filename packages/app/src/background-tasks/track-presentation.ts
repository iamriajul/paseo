import type { TFunction } from "i18next";
import type { BackgroundTaskDescriptorPayload } from "@getpaseo/protocol/messages";
import type { ComposerTrackPillSegment } from "@/composer/tracks";

export interface BackgroundTaskPillPresentation {
  segments: ComposerTrackPillSegment[];
  accessibilityLabel: string;
}

/**
 * The pill stays compact — "[ring] 3 shells" — and the ring appears only while something is
 * actually running. The panel behind it carries per-task detail; the accessibility label spells
 * the count out instead of leaving a bare number.
 */
export function buildBackgroundTaskPillPresentation(
  t: TFunction,
  rows: readonly BackgroundTaskDescriptorPayload[],
): BackgroundTaskPillPresentation {
  const runningCount = rows.reduce(
    (count, row) => (row.status === "running" ? count + 1 : count),
    0,
  );
  const text = t("backgroundTasks.pillCount", { count: rows.length });
  const accessibilityLabel =
    runningCount > 0
      ? t("backgroundTasks.pillCountRunningAccessible", {
          count: rows.length,
          running: runningCount,
        })
      : t("backgroundTasks.pillCountAccessible", { count: rows.length });
  return {
    segments: [{ bucket: runningCount > 0 ? "running" : null, text }],
    accessibilityLabel,
  };
}
