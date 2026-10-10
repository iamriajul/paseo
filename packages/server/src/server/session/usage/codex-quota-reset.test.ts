import pino from "pino";
import { expect, test, vi } from "vitest";
import { consumeCodexResetCredit, resetCodexQuota } from "./codex-quota-reset.js";

const logger = pino({ level: "silent" });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const authRecord = {
  auth: {
    tokens: { access_token: "access-1", refresh_token: "refresh-1", account_id: "acct-1" },
  },
  path: "/tmp/codex-auth.json",
};

test("consumes a reset credit and reports windows reset", async () => {
  const fetchApi = vi.fn(async () => jsonResponse({ code: "reset", windows_reset: 2 }));
  const result = await consumeCodexResetCredit({
    logger,
    fetchApi: fetchApi as unknown as typeof fetch,
    authRecord,
  });
  expect(result).toEqual({
    providerId: "codex",
    code: "reset",
    windowsReset: 2,
    message: "Reset quota consumed. Windows reset: 2.",
  });
  expect(fetchApi).toHaveBeenCalledTimes(1);
  const [url, init] = fetchApi.mock.calls[0] as [string, RequestInit];
  expect(url).toContain("rate-limit-reset-credits/consume");
  expect(init.method).toBe("POST");
});

test("rejects non-codex providers without calling the API", async () => {
  const fetchApi = vi.fn(async () => jsonResponse({}));
  await expect(
    resetCodexQuota({ logger, fetchApi: fetchApi as unknown as typeof fetch }, "claude"),
  ).rejects.toThrow("only supported for codex");
  expect(fetchApi).not.toHaveBeenCalled();
});

test("reports a no-credit result instead of throwing", async () => {
  const fetchApi = vi.fn(async () => jsonResponse({ code: "no_credit" }));
  const result = await consumeCodexResetCredit({
    logger,
    fetchApi: fetchApi as unknown as typeof fetch,
    authRecord,
  });
  expect(result.code).toBe("no_credit");
  expect(result.message).toContain("no reset credits");
});

test("refreshes expired auth once and retries the consume", async () => {
  const fetchApi = vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes("oauth/token")) return jsonResponse({ access_token: "access-2" });
    if (href.includes("consume")) {
      return fetchApi.mock.calls.filter(([u]) => String(u).includes("consume")).length === 1
        ? new Response("", { status: 401 })
        : jsonResponse({ code: "reset", windows_reset: 1 });
    }
    throw new Error(`unexpected ${href}`);
  });
  const result = await consumeCodexResetCredit({
    logger,
    fetchApi: fetchApi as unknown as typeof fetch,
    authRecord,
  });
  expect(result).toMatchObject({ providerId: "codex", code: "reset", windowsReset: 1 });
});
