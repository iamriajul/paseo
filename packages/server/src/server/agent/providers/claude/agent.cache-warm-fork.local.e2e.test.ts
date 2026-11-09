import { createServer } from "node:http";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { collectSessionTurnEvents } from "../test-utils/session-stream-adapter.js";
import { ClaudeAgentClient } from "./agent.js";

interface CapturedRequest {
  messages: Array<{ role: string; content: unknown }>;
  system: unknown;
  tools: unknown;
}

function requestText(request: CapturedRequest): string {
  return JSON.stringify(request.messages);
}

// A warm-up fork is a fresh Claude Code process resuming the session. On start it re-reads the
// instruction files (CLAUDE.md, auto-memory) and appends every one that changed since the
// session's copy, in full, to its prompt. The agent's own process sends nothing of the kind, so
// those tokens are written to the cache on every warm-up and never read again.
test("a warm-up fork does not resend instruction files that changed during the session", async () => {
  const cwd = await mkdtemp(path.resolve(".claude-cache-warm-fork-"));
  const configDir = path.join(cwd, "config");
  await mkdir(configDir);
  await writeFile(path.join(configDir, "settings.json"), "{}");
  const claudeMd = path.join(cwd, "CLAUDE.md");
  await writeFile(claudeMd, "# Project\n\n- the first rule\n");
  const requests: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    const parsed = JSON.parse(body) as CapturedRequest & { stream?: boolean };
    requests.push(parsed);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (data: { type: string; [key: string]: unknown }) => {
      response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    emit({
      type: "message_start",
      message: {
        id: `msg_fork_${requests.length}`,
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 0,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 1_000,
        },
      },
    });
    emit({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    emit({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
    emit({ type: "content_block_stop", index: 0 });
    emit({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    emit({ type: "message_stop" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture has no TCP address");
  const client = new ClaudeAgentClient({
    logger: pino({ level: "silent" }),
    runtimeSettings: {
      env: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        ANTHROPIC_AUTH_TOKEN: "fixture-token",
        ANTHROPIC_API_KEY: "",
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    },
  });
  const session = await client.createSession({
    provider: "claude",
    cwd,
    model: "claude-haiku-5-5",
    featureValues: { prompt_cache_ttl: "5m" },
  });
  try {
    await collectSessionTurnEvents(session, "say ok", { signal: AbortSignal.timeout(30_000) });
    const agentRequest = requests.at(-1)!;
    expect(requestText(agentRequest)).toContain("the first rule");

    await appendFile(claudeMd, "- a rule added while the agent ran\n");
    const before = requests.length;
    await expect(session.warmPromptCache!()).resolves.toMatchObject({ readTokens: 1_000 });
    const fork = requests.slice(before).at(-1)!;

    // The fork keeps the cache key: same system prompt, tools and history as the agent's request.
    expect(fork.system).toEqual(agentRequest.system);
    expect(fork.tools).toEqual(agentRequest.tools);
    expect(fork.messages[0]).toEqual(agentRequest.messages[0]);
    // And sends no fresh copy of the changed instruction file.
    expect(requestText(fork)).not.toContain("a rule added while the agent ran");
    expect(requestText(fork)).not.toContain("these differ from their earlier copies");
  } finally {
    try {
      await session.close();
    } finally {
      try {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  }
}, 90_000);
