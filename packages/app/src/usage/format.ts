import { formatTokenCount } from "@/components/context-window-meter.utils";
import type { UsageDisplayAs } from "./preferences";
import type { UsageBalanceUnit } from "./types";

export function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function formatPct(value: number): string {
  return `${Math.round(clampPct(value))}%`;
}

/** "31%" of the window used, or "69% left" of it. */
export function formatDisplayPct(value: number, displayAs: UsageDisplayAs): string {
  return displayAs === "used" ? formatPct(value) : `${formatPct(value)} left`;
}

export function relativeDuration(iso: string, now = Date.now()): string | null {
  const targetMs = new Date(iso).getTime();
  if (!Number.isFinite(targetMs)) return null;
  const diffMs = targetMs - now;
  if (diffMs <= 0) return "now";
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  const remHours = diffHours % 24;
  const remMinutes = diffMinutes % 60;

  if (diffDays > 0) {
    return remHours > 0 ? `${diffDays}d${remHours}h` : `${diffDays}d`;
  }
  if (diffHours > 0) {
    return remMinutes > 0 ? `${diffHours}h${remMinutes}m` : `${diffHours}h`;
  }
  return diffMinutes > 0 ? `${diffMinutes}m` : "<1m";
}

export function formatResetLabel(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const rel = relativeDuration(iso, now);
  if (!rel) return null;
  return rel === "now" ? "resetting now" : `resets ${rel}`;
}

export function formatAgo(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const diffMs = now - new Date(iso).getTime();
  if (!Number.isFinite(diffMs)) return null;
  if (diffMs < 60_000) return "just now";
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays > 0) return `${diffDays}d ago`;
  if (diffHours > 0) return `${diffHours}h ago`;
  return `${diffMinutes}m ago`;
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
export function formatAmount(value: number, unit: UsageBalanceUnit, locale: string): string {
  switch (unit) {
    case "usd":
      return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(value);
    case "tokens":
      return formatTokenCount(value);
    default:
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  }
}
