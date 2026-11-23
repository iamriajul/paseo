/**
 * When a Codex turn fails because the ChatGPT account is out of quota, work out when the quota
 * resets. The session puts that time on its `turn_failed` event (`rateLimitResetsAt`), and the
 * daemon's rate-limit auto-resume schedules from it.
 */

/** `codexErrorInfo` values that mean the account cannot serve until its limit window resets. */
const QUOTA_ERROR_CODES: ReadonlySet<string> = new Set(["usageLimitExceeded", "rateLimitExceeded"]);

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Codex renders the reset in its process's local time: "4:45 PM" when the reset falls on today's
// local date, "Nov 24th, 2026 4:45 PM" otherwise (codex-rs `format_retry_timestamp`).
const TRY_AGAIN_AT =
  /try again at (?:([A-Za-z]{3})[a-z]* (\d{1,2})(?:st|nd|rd|th)?, (\d{4}) )?(\d{1,2}):(\d{2})\s*([AP]M)/i;

const MINUTE_MS = 60_000;

/** One limit window from `account/rateLimits/updated`; `resetsAt` is in Unix seconds. */
export interface CodexRateLimitWindow {
  usedPercent: number;
  resetsAt: number | null;
}

export interface CodexRateLimitState {
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
}

export function isCodexQuotaErrorInfo(codexErrorInfo: unknown): boolean {
  return typeof codexErrorInfo === "string" && QUOTA_ERROR_CODES.has(codexErrorInfo);
}

/**
 * Reads "try again at 4:45 PM" from a Codex usage-limit message, in the host's local time (the
 * app-server is a child of the daemon and inherits its timezone). Codex drops the seconds, so this
 * returns the end of the minute shown: the earliest time the reset is certain to have passed.
 */
export function parseCodexTryAgainAt(message: string, now: Date): Date | null {
  const match = TRY_AGAIN_AT.exec(message);
  if (!match) return null;
  const [, monthName, dayText, yearText, hourText, minuteText, meridiem] = match;
  const hour12 = Number(hourText);
  const minute = Number(minuteText);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + (meridiem.toUpperCase() === "PM" ? 12 : 0);

  if (monthName) {
    const month = MONTHS.indexOf(monthName.toLowerCase());
    if (month < 0) return null;
    const shown = new Date(Number(yearText), month, Number(dayText), hour, minute);
    if (shown.getDate() !== Number(dayText)) return null;
    return new Date(shown.getTime() + MINUTE_MS);
  }

  const shown = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
  // A bare time is on Codex's local date when it wrote the message. One already over by now was
  // written before midnight, so it means the same time on the next day.
  if (shown.getTime() + MINUTE_MS <= now.getTime()) shown.setDate(shown.getDate() + 1);
  return new Date(shown.getTime() + MINUTE_MS);
}

/** The time every used-up window has reset, or null when no window is used up. */
export function exhaustedWindowsResetAt(state: CodexRateLimitState): Date | null {
  let latest: number | null = null;
  for (const window of [state.primary, state.secondary]) {
    if (!window || window.usedPercent < 100 || window.resetsAt === null) continue;
    latest = Math.max(latest ?? 0, window.resetsAt * 1000);
  }
  return latest === null ? null : new Date(latest);
}

export interface CodexQuotaFailure {
  message: string;
  codexErrorInfo: unknown;
  rateLimits: CodexRateLimitState;
  now: Date;
}

/**
 * The reset time for a failed Codex turn, or null when the failure is not a quota error or Codex
 * gave no time. The message's time comes first: it is the `resets_at` Codex read from this very
 * error. The latest rate-limit snapshot covers an error whose text carries no time.
 */
export function resolveCodexQuotaResetAt(failure: CodexQuotaFailure): Date | null {
  const fromMessage = parseCodexTryAgainAt(failure.message, failure.now);
  if (!isCodexQuotaErrorInfo(failure.codexErrorInfo) && !fromMessage) return null;
  return fromMessage ?? exhaustedWindowsResetAt(failure.rateLimits);
}
