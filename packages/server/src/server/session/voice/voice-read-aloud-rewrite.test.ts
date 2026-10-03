import { describe, expect, test, vi } from "vitest";

import {
  buildReadAloudRewritePrompt,
  rewriteWithCustomEndpoint,
} from "./voice-read-aloud-rewrite.js";

describe("buildReadAloudRewritePrompt", () => {
  test("embeds the source text and spoken-prose instructions", () => {
    const prompt = buildReadAloudRewritePrompt(
      "Fixed `login()` — see [docs](https://example.com).",
    );
    expect(prompt).toContain("Fixed `login()` — see [docs](https://example.com).");
    expect(prompt).toContain("never recite it verbatim");
    expect(prompt).toContain("plain text only");
  });
});

describe("rewriteWithCustomEndpoint", () => {
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
        await rewriteWithCustomEndpoint({
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

  test("returns rewritten text on stubbed-200 via the custom endpoint", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ text: "Fixed the login bug." }) } }],
          }),
          { status: 200 },
        ),
    );
    const seen: string[] = [];
    const recordingFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(String(init?.body ?? ""));
      return fetchImpl(url as string, init);
    }) as unknown as typeof fetch;

    const result = await rewriteWithCustomEndpoint({
      text: "Fixed the **login** bug.",
      endpoint: { enabled: true, baseUrl: "http://127.0.0.1:11434/v1", model: "llama3" },
      fetchImpl: recordingFetch,
    });

    expect(result).toEqual({ rewrittenText: "Fixed the login bug." });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect((JSON.parse(seen[0] as string) as { model: string }).model).toBe("llama3");
  });

  test("maps generation failures to rewrite_failed", async () => {
    const result = await rewriteWithCustomEndpoint({
      text: "hello",
      endpoint: { enabled: true, baseUrl: "http://127.0.0.1:11434/v1", model: "llama3" },
      generate: (async () => {
        throw new Error("boom");
      }) as unknown as typeof generateMetadataOpenAIStructured,
    });
    expect(result).toEqual({ error: { code: "rewrite_failed", message: "boom" } });
  });
});
