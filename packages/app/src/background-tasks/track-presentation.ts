import type { TFunction } from "i18next";
import type { BackgroundTaskDescriptorPayload } from "@getpaseo/protocol/messages";
import type { ComposerTrackPillSegment } from "@/composer/tracks";

export interface BackgroundTaskPillPresentation {
  segments: ComposerTrackPillSegment[];
  accessibilityLabel: string;
}

export function buildBackgroundTaskPillPresentation(
  t: TFunction,
  rows: readonly BackgroundTaskDescriptorPayload[],
): BackgroundTaskPillPresentation {
  const runningCount = rows.reduce(
    (count, row) => (row.status === "running" ? count + 1 : count),
    0,
  );
  const label =
    runningCount > 0
      ? t("backgroundTasks.headerCountRunning", { count: rows.length, running: runningCount })
      : t("backgroundTasks.headerCount", { count: rows.length });
  return {
    segments: [{ bucket: runningCount > 0 ? "running" : null, text: label }],
    accessibilityLabel: label,
  };
}
