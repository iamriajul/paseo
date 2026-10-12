/**
 * Convert an exact rolling interval to an equivalent five-field cron cadence.
 * Returns null when cron's calendar boundaries would change the interval.
 */
export function everyMsToFiveFieldCron(everyMs: number): string | null {
  const minutes = everyMs / 60_000;
  if (!Number.isInteger(minutes) || minutes <= 0) {
    return null;
  }
  if (minutes < 60 && 60 % minutes === 0) {
    return `*/${minutes} * * * *`;
  }
  if (minutes === 60) {
    return "0 * * * *";
  }
  if (minutes % 60 !== 0) {
    return null;
  }
  const hours = minutes / 60;
  if (hours < 24 && 24 % hours === 0) {
    return `0 */${hours} * * *`;
  }
  if (hours === 24) {
    return "0 0 * * *";
  }
  return null;
}

export interface CronDateParts {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
}

export function getCronDateParts(date: Date, timezone?: string): CronDateParts {
  if (!timezone) {
    return {
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      dayOfMonth: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      dayOfWeek: date.getUTCDay(),
    };
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  const values: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  const year = Number.parseInt(values.year, 10);
  const month = Number.parseInt(values.month, 10);
  const dayOfMonth = Number.parseInt(values.day, 10);

  return {
    minute: Number.parseInt(values.minute, 10),
    hour: Number.parseInt(values.hour, 10),
    dayOfMonth,
    month,
    dayOfWeek: new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay(),
  };
}

export function dateToCronExpression(date: Date, timezone?: string): string {
  const parts = getCronDateParts(date, timezone);
  return `${parts.minute} ${parts.hour} ${parts.dayOfMonth} ${parts.month} *`;
}
