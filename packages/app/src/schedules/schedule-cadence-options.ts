import type { ScheduleCadence } from "@getpaseo/protocol/schedule/types";
import { dateToCronExpression, getCronDateParts } from "@getpaseo/protocol/schedule/cadence";
import { describeCron, everyMsToParts } from "@/utils/schedule-format";

type CronCadence = Extract<ScheduleCadence, { type: "cron" }>;

export interface CadencePresetOption {
  id: string;
  label: string;
  expression: string;
}

export const CUSTOM_CRON_PRESET_ID = "custom";

export const CADENCE_PRESET_OPTIONS: CadencePresetOption[] = [
  { id: "every-minute", label: "Every minute", expression: "* * * * *" },
  { id: "every-hour", label: "Every hour", expression: "0 * * * *" },
  { id: "daily-9", label: "Daily 9:00", expression: "0 9 * * *" },
  { id: "weekdays-9", label: "Weekdays 9:00", expression: "0 9 * * 1-5" },
  { id: "mondays-9", label: "Mondays 9:00", expression: "0 9 * * 1" },
];

export function resolveCronPresetId(cadence: CronCadence): string {
  const expression = cadence.expression.trim();
  return (
    CADENCE_PRESET_OPTIONS.find((option) => option.expression === expression)?.id ??
    CUSTOM_CRON_PRESET_ID
  );
}

export function resolveCronPresetDisplay(cadence: CronCadence): { label: string } {
  const presetLabel = CADENCE_PRESET_OPTIONS.find(
    (option) => option.id === resolveCronPresetId(cadence),
  )?.label;
  if (presetLabel) {
    return { label: presetLabel };
  }
  const described = describeCron(cadence);
  if (described) {
    return { label: described };
  }
  return {
    label: "Custom cron",
  };
}

export function normalizeScheduleFormCadence(
  cadence: ScheduleCadence,
  timezone: string,
): CronCadence {
  if (cadence.type === "cron") {
    return { ...cadence, timezone: cadence.timezone ?? timezone };
  }

  return {
    type: "cron",
    expression: everyMsToCronExpression(cadence.everyMs),
    timezone,
  };
}

function everyMsToCronExpression(everyMs: number): string {
  const { value, unit } = everyMsToParts(everyMs);
  if (unit === "minutes") {
    return value === 1 ? "* * * * *" : `*/${Math.min(value, 59)} * * * *`;
  }
  if (unit === "hours") {
    return value === 1 ? "0 * * * *" : `0 */${Math.min(value, 23)} * * *`;
  }
  return value === 1 ? "0 9 * * *" : `0 9 */${Math.min(value, 31)} * *`;
}

export interface TimerPresetOption {
  id: string;
  label: string;
  minutes?: number;
  tomorrow?: { hour: number; minute: number };
}

export const TIMER_PRESET_OPTIONS: readonly TimerPresetOption[] = [
  { id: "in-15m", label: "In 15 minutes", minutes: 15 },
  { id: "in-30m", label: "In 30 minutes", minutes: 30 },
  { id: "in-1h", label: "In 1 hour", minutes: 60 },
  { id: "in-2h", label: "In 2 hours", minutes: 120 },
  { id: "in-4h", label: "In 4 hours", minutes: 240 },
  { id: "tomorrow-9", label: "Tomorrow 9:00", tomorrow: { hour: 9, minute: 0 } },
];

export function isTimerPresetId(id: string): boolean {
  return TIMER_PRESET_OPTIONS.some((option) => option.id === id);
}

export function buildTimerCadence(
  minutes: number,
  timezone: string,
  now = new Date(),
): CronCadence {
  const target = new Date(now.getTime() + minutes * 60_000);
  return {
    type: "cron",
    expression: dateToCronExpression(target, timezone),
    timezone,
  };
}

export function buildTomorrowCadence(
  hour: number,
  minute: number,
  timezone: string,
  now = new Date(),
): CronCadence {
  const target = new Date(now.getTime() + 24 * 60 * 60_000);
  const parts = getCronDateParts(target, timezone);
  return {
    type: "cron",
    expression: `${minute} ${hour} ${parts.dayOfMonth} ${parts.month} *`,
    timezone,
  };
}

export function buildTimerPresetCadence(
  presetId: string,
  timezone: string,
  now = new Date(),
): CronCadence | null {
  const preset = TIMER_PRESET_OPTIONS.find((option) => option.id === presetId);
  if (!preset) return null;
  if (preset.minutes !== undefined) {
    return buildTimerCadence(preset.minutes, timezone, now);
  }
  if (preset.tomorrow !== undefined) {
    return buildTomorrowCadence(preset.tomorrow.hour, preset.tomorrow.minute, timezone, now);
  }
  return null;
}
