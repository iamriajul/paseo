import type { TFunction } from "i18next";
import { i18n } from "@/i18n/i18next";
import type { UsageDisplayAs } from "./preferences";
import type { UsageBalanceUnit } from "./types";

const providerUsageLabels = {
  session: { label: "Session", key: "providerUsage.labels.session" },
  weekly: { label: "Weekly", key: "providerUsage.labels.weekly" },
  monthly: { label: "Monthly", key: "providerUsage.labels.monthly" },
  code_review: { label: "Code review", key: "providerUsage.labels.codeReview" },
  credits: { label: "Credits", key: "providerUsage.labels.credits" },
  monthly_credits: { label: "Monthly credits", key: "providerUsage.labels.monthlyCredits" },
} as const;

export function formatProviderUsageLabel(id: string, label: string, t: TFunction = i18n.t): string {
  const reviewPrefix = "Code review · ";
  if (id.startsWith("code_review:") && label.startsWith(reviewPrefix)) {
    const periodId = id.slice("code_review:".length);
    const periodLabel = label.slice(reviewPrefix.length);
    return `${t(providerUsageLabels.code_review.key)} · ${formatProviderUsageLabel(periodId, periodLabel, t)}`;
  }
  const standard =
    providerUsageLabels[id as keyof typeof providerUsageLabels] ??
    (id === "five_hour" ? providerUsageLabels.session : undefined);
  return standard?.label === label ? t(standard.key) : label;
}

export function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function formatPct(value: number, locale?: string): string {
  const resolvedLocale = locale ?? i18n.resolvedLanguage;
  return new Intl.NumberFormat(resolvedLocale, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(clampPct(value) / 100);
}

/** A localized percentage that says whether it is used or remaining. */
export function formatDisplayPct(
  value: number,
  displayAs: UsageDisplayAs,
  locale?: string,
  t: TFunction = i18n.t,
): string {
  const percentage = formatPct(value, locale);
  return displayAs === "used"
    ? t("providerUsage.values.used", { percentage })
    : t("providerUsage.values.remaining", { amount: percentage });
}

type DurationUnit = "minutes" | "hours" | "days";
// A fork extension: durations keep their next-smaller unit ("1d 5h", "5h 30m") so a quota
// reset reads precisely, and anything under a minute reads "<1m" instead of "0m".
type RelativeDuration =
  | { unit: "now" }
  | { unit: "lessThanMinute" }
  | {
      unit: DurationUnit;
      count: number;
      remainder?: { unit: Exclude<DurationUnit, "days">; count: number };
    };

function formatCount(value: number): string {
  return new Intl.NumberFormat(i18n.resolvedLanguage).format(value);
}

export function relativeDuration(iso: string, now: number): RelativeDuration | null {
  const diffMs = new Date(iso).getTime() - now;
  if (!Number.isFinite(diffMs)) return null;
  if (diffMs <= 0) return { unit: "now" };
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  const remHours = diffHours % 24;
  const remMinutes = diffMinutes % 60;
  if (diffDays > 0) {
    return remHours > 0
      ? { unit: "days", count: diffDays, remainder: { unit: "hours", count: remHours } }
      : { unit: "days", count: diffDays };
  }
  if (diffHours > 0) {
    return remMinutes > 0
      ? { unit: "hours", count: diffHours, remainder: { unit: "minutes", count: remMinutes } }
      : { unit: "hours", count: diffHours };
  }
  if (diffMinutes > 0) return { unit: "minutes", count: diffMinutes };
  return { unit: "lessThanMinute" };
}

function formatDurationUnit(unit: DurationUnit, count: number, t: TFunction): string {
  return t(`providerUsage.duration.${unit}`, { count, value: formatCount(count) });
}

function formatRelativeDuration(duration: RelativeDuration, t: TFunction): string | null {
  switch (duration.unit) {
    case "now":
      return null;
    case "lessThanMinute":
      return `<${formatDurationUnit("minutes", 1, t)}`;
    default: {
      const base = formatDurationUnit(duration.unit, duration.count, t);
      return duration.remainder
        ? `${base} ${formatDurationUnit(duration.remainder.unit, duration.remainder.count, t)}`
        : base;
    }
  }
}

/**
 * A countdown in the quota-reset style, down to seconds: "1d5h", "5h30m", "3m40s", "40s".
 * Seconds round up, so a countdown never reads "0s" while time is left.
 */
export function formatPreciseDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) {
    return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

/**
 * A live countdown as a clock: "3:40", "0:09", "58:00". Minutes are not wrapped into hours,
 * so a prompt-cache window (at most 60 minutes) always reads as minutes and seconds.
 * Seconds round up, so it never reads "0:00" while time is left.
 */
export function formatCountdownClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatResetLabel(
  iso: string | null | undefined,
  retained = false,
  now = Date.now(),
  t: TFunction = i18n.t,
): string | null {
  if (!iso) return null;
  const rel = relativeDuration(iso, now);
  if (!rel) return null;
  if (rel.unit === "now" && retained) return t("providerUsage.timing.resetTimePassed");
  if (rel.unit === "now") return t("providerUsage.timing.resettingNow");
  const duration = formatRelativeDuration(rel, t);
  return duration ? t("providerUsage.timing.resetsIn", { duration }) : null;
}

export function formatRunsOutLabel(
  iso: string | null | undefined,
  now = Date.now(),
  t: TFunction = i18n.t,
): string | null {
  if (!iso) return null;
  const rel = relativeDuration(iso, now);
  if (!rel) return null;
  if (rel.unit === "now") return t("providerUsage.timing.runsOutNow");
  const duration = formatRelativeDuration(rel, t);
  return duration ? t("providerUsage.timing.runsOutIn", { duration }) : null;
}

export function formatAgo(
  iso: string | null | undefined,
  now = Date.now(),
  t: TFunction = i18n.t,
): string | null {
  if (!iso) return null;
  const diffMs = now - new Date(iso).getTime();
  if (!Number.isFinite(diffMs)) return null;
  if (diffMs < 60_000) return t("providerUsage.timing.justNow");
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays > 0) {
    return t("providerUsage.timing.daysAgo", {
      count: diffDays,
      value: formatCount(diffDays),
    });
  }
  if (diffHours > 0) {
    return t("providerUsage.timing.hoursAgo", {
      count: diffHours,
      value: formatCount(diffHours),
    });
  }
  return t("providerUsage.timing.minutesAgo", {
    count: diffMinutes,
    value: formatCount(diffMinutes),
  });
}

export function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

/** A balance amount as the app's language writes it: "$1,234.50", "12,345". */
export function formatAmount(value: number, unit: UsageBalanceUnit, locale?: string): string {
  switch (unit) {
    case "usd":
      return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(value);
    case "tokens":
      return new Intl.NumberFormat(locale, {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(value);
    default:
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  }
}
