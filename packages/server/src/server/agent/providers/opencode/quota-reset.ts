import { z } from "zod";

// OpenCode retries a retryable provider error itself and only reports `session.error` once it
// gives up, so a quota error that reaches Paseo is one OpenCode will not retry. Its `APIError`
// keeps the upstream status, headers and body; this reads the reset time out of them.
const ApiErrorSchema = z.object({
  name: z.literal("APIError"),
  data: z
    .object({
      statusCode: z.number().optional(),
      responseHeaders: z.record(z.string(), z.string()).optional(),
      responseBody: z.string().optional(),
    })
    .passthrough(),
});

// OpenAI's `usage_limit_reached` (ChatGPT login) carries `resets_at` in Unix seconds, or only
// `resets_in_seconds`.
const UsageLimitBodySchema = z.object({
  error: z
    .object({
      resets_at: z.number().optional(),
      resets_in_seconds: z.number().optional(),
    })
    .passthrough(),
});

const QUOTA_STATUS_CODES = new Set([402, 429]);

function readHeader(headers: Record<string, string> | undefined, name: string): string | null {
  if (!headers) return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return null;
}

function fromRetryAfter(value: string | null, now: Date): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return new Date(now.getTime() + Number(trimmed) * 1000);
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

function fromBody(body: string | undefined, now: Date): Date | null {
  if (!body) return null;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = UsageLimitBodySchema.safeParse(json);
  if (!parsed.success) return null;
  const { resets_at, resets_in_seconds } = parsed.data.error;
  if (resets_at !== undefined) return new Date(resets_at * 1000);
  if (resets_in_seconds !== undefined) return new Date(now.getTime() + resets_in_seconds * 1000);
  return null;
}

/** The quota reset time of an OpenCode `session.error`, or null when it is not a quota error. */
export function resolveOpenCodeQuotaResetAt(error: unknown, now: Date): Date | null {
  const parsed = ApiErrorSchema.safeParse(error);
  if (!parsed.success) return null;
  const { statusCode, responseHeaders, responseBody } = parsed.data.data;
  if (statusCode === undefined || !QUOTA_STATUS_CODES.has(statusCode)) return null;
  return (
    fromBody(responseBody, now) ?? fromRetryAfter(readHeader(responseHeaders, "retry-after"), now)
  );
}
