import { describe, expect, test, vi } from "vitest";

import { buildDictationPolishPrompt, polishWithCustomEndpoint } from "./voice-dictation-polish.js";

describe("buildDictationPolishPrompt", () => {
  test("embeds the draft and faithful-cleanup instructions", () => {
    const prompt = buildDictationPolishPrompt("um can you, uh, fix the login bug");
    expect(prompt).toContain("um can you, uh, fix the login bug");
    expect(prompt).toContain("do not change the topic");
    expect(prompt).toContain("chat-ready text only");
  });
});

describe("polishWithCustomEndpoint", () => {
  test("returns endpoint_not_configured when the custom endpoint is disabled or incomplete", async () => {
    const generate = vi.fn();
    for (const endpoint of [
      undefined,
      null,
      { enabled: false, baseUrl: "http://127.0.0.1:11434/v1", model: "llama3" },
      { enabled: true, baseUrl: "", model: "llama3" },
      { enabled: true, baseUrl: "http://127.0.0.1:11434/v1", model: "" },
    ]) {
      expect(
        await polishWithCustomEndpoint({
          text: "hello",
          endpoint,
          generate: generate as unknown as typeof generateMetadataOpenAIStructured,
        }),
      ).toEqual({
        error: { code: "endpoint_not_configured", message: expect.any(String) },
      });
    }
    expect(generate).not.toHaveBeenCalled();
  });

  test("returns polished text on stubbed-200 via the custom endpoint", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ text: "Can you fix the login bug?" }) } },
            ],
          }),
          { status: 200 },
        ),
    );
    const seen: string[] = [];
    const recordingFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(String(init?.body ?? ""));
      return fetchImpl(url as string, init);
    }) as unknown as typeof fetch;

    const result = await polishWithCustomEndpoint({
      text: "um can you, uh, fix the login bug",
      endpoint: { enabled: true, baseUrl: "http://127.0.0.1:11434/v1", model: "llama3" },
      fetchImpl: recordingFetch,
    });

    expect(result).toEqual({ polishedText: "Can you fix the login bug?" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect((JSON.parse(seen[0] as string) as { model: string }).model).toBe("llama3");
  });

  test("maps generation failures to rewrite_failed", async () => {
    const result = await polishWithCustomEndpoint({
      text: "hello",
      endpoint: { enabled: true, baseUrl: "http://127.0.0.1:11434/v1", model: "llama3" },
      generate: (async () => {
        throw new Error("boom");
      }) as unknown as typeof generateMetadataOpenAIStructured,
    });
    expect(result).toEqual({ error: { code: "rewrite_failed", message: "boom" } });
  });
});
