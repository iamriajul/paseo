import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_RESET_REQUEST_TIMEOUT_MS = 30_000;

const CodexAuthSchema = z.object({
  tokens: z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().optional(),
      account_id: z.string().optional(),
    })
    .optional(),
});

const CodexResetQuotaResponseSchema = z.object({
  code: z.string().optional(),
  windows_reset: z.number().nullable().optional(),
});

const CodexTokenRefreshSchema = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
});

type CodexAuth = z.infer<typeof CodexAuthSchema>;
type CodexResetQuotaResponse = z.infer<typeof CodexResetQuotaResponseSchema>;
type CodexTokenRefresh = z.infer<typeof CodexTokenRefreshSchema>;

export interface CodexResetAuth {
  auth: CodexAuth;
  path: string;
}

export interface CodexQuotaResetResult {
  providerId: string;
  code: string;
  windowsReset: number | null;
  message: string | null;
}

export interface CodexQuotaResetDeps {
  logger: Logger;
  fetchApi?: typeof fetch;
  codexHome?: string;
}

function codexHeaders(token: string, accountId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  };
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  return headers;
}

function resetQuotaMessage(code: string, windowsReset: number | null): string {
  switch (code) {
    case "reset":
      return windowsReset && windowsReset > 0
        ? `Reset quota consumed. Windows reset: ${windowsReset}.`
        : "Reset quota consumed.";
    case "nothing_to_reset":
      return "No reset was consumed because there is nothing to reset.";
    case "no_credit":
      return "No reset was consumed because no reset credits are available.";
    case "already_redeemed":
      return "This reset request was already redeemed.";
    default:
      return `Codex returned reset result: ${code}.`;
  }
}

async function readCodexAuth(codexHome?: string): Promise<CodexResetAuth | null> {
  const candidates = [
    ...(process.env["CODEX_HOME"] ? [join(process.env["CODEX_HOME"], "auth.json")] : []),
    join(homedir(), ".config", "codex", "auth.json"),
    ...(codexHome ? [join(codexHome, "auth.json")] : []),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const auth = CodexAuthSchema.parse(JSON.parse(await fs.readFile(path, "utf8")));
      if (auth.tokens?.access_token) return { auth, path };
    } catch {
      continue;
    }
  }
  return null;
}

async function callResetQuotaApi(
  fetchApi: typeof fetch,
  token: string,
  accountId?: string,
): Promise<CodexResetQuotaResponse | "NEEDS_AUTH"> {
  const res = await fetchApi(
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
    {
      method: "POST",
      headers: {
        ...codexHeaders(token, accountId),
        "Content-Type": "application/json",
        originator: "Codex Desktop",
        "OAI-Product-Sku": "CODEX",
      },
      body: JSON.stringify({ redeem_request_id: randomUUID() }),
      signal: AbortSignal.timeout(CODEX_RESET_REQUEST_TIMEOUT_MS),
    },
  );
  if (res.status === 401 || res.status === 403) return "NEEDS_AUTH";
  if (!res.ok) throw new Error(`Codex reset quota API returned ${res.status}`);
  const text = await res.text();
  if (text.trim().startsWith("<")) return "NEEDS_AUTH";
  return CodexResetQuotaResponseSchema.parse(JSON.parse(text));
}

async function refreshCodexToken(
  fetchApi: typeof fetch,
  refreshToken: string,
): Promise<CodexTokenRefresh | null> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CODEX_CLIENT_ID,
    refresh_token: refreshToken,
  });
  const res = await fetchApi("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    signal: AbortSignal.timeout(CODEX_RESET_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  return CodexTokenRefreshSchema.parse(await res.json());
}

async function saveCodexAuth(
  authPath: string,
  original: CodexAuth,
  refreshed: CodexTokenRefresh,
): Promise<void> {
  try {
    const updated: CodexAuth = {
      ...original,
      tokens: {
        ...original.tokens,
        access_token: refreshed.access_token ?? original.tokens?.access_token,
        refresh_token: refreshed.refresh_token ?? original.tokens?.refresh_token,
      },
    };
    await fs.writeFile(authPath, JSON.stringify(updated, null, 2), { mode: 0o600 });
  } catch {
    // Non-fatal; the next call can refresh again.
  }
}

/** Pure consume step with an already-read auth record; exported for tests. */
export async function consumeCodexResetCredit(options: {
  logger: Logger;
  fetchApi: typeof fetch;
  authRecord: CodexResetAuth;
}): Promise<CodexQuotaResetResult> {
  const { logger, fetchApi, authRecord } = options;
  const auth = authRecord.auth;
  const accessToken = auth.tokens?.access_token;
  if (!accessToken) {
    throw new Error("Codex auth is unavailable");
  }

  const { refresh_token, account_id } = auth.tokens ?? {};
  let resp = await callResetQuotaApi(fetchApi, accessToken, account_id);

  if (resp === "NEEDS_AUTH") {
    if (!refresh_token) {
      throw new Error("Codex auth expired");
    }
    const refreshed = await refreshCodexToken(fetchApi, refresh_token);
    if (!refreshed?.access_token) {
      throw new Error("Unable to refresh Codex auth");
    }
    await saveCodexAuth(authRecord.path, auth, refreshed);
    logger.debug("Refreshed Codex auth for quota reset");
    resp = await callResetQuotaApi(fetchApi, refreshed.access_token, account_id);
    if (resp === "NEEDS_AUTH") {
      throw new Error("Codex auth expired");
    }
  }

  const code = resp.code ?? "unknown";
  const windowsReset = resp.windows_reset ?? null;
  return {
    providerId: "codex",
    code,
    windowsReset,
    message: resetQuotaMessage(code, windowsReset),
  };
}

/**
 * Consume one Codex rate-limit reset credit. Only the `codex` provider is
 * supported; anything else throws. Throws when Codex auth is unavailable or
 * expired so the caller can surface an rpc_error instead of a reset result.
 */
export async function resetCodexQuota(
  deps: CodexQuotaResetDeps,
  providerId: string,
): Promise<CodexQuotaResetResult> {
  if (providerId !== "codex") {
    throw new Error(`Quota reset is only supported for codex, not ${providerId}`);
  }
  const { logger, fetchApi = fetch, codexHome } = deps;
  const authRecord = await readCodexAuth(codexHome);
  if (!authRecord?.auth.tokens?.access_token) {
    throw new Error("Codex auth is unavailable");
  }
  return consumeCodexResetCredit({ logger, fetchApi, authRecord });
}
