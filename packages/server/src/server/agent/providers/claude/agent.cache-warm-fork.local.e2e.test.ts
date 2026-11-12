// The v2 warm-up contract: three Claude Code behaviours the fork warm-up (`warmPromptCache`)
// relies on, each measured on a single Claude Code version. This suite runs the Claude Code the
// daemon would launch against a local stub of the Messages API, so a Claude Code upgrade that
// breaks one fails here before release (docs/release.md, "Claude Code contract").
//
// 1. The fork's request names the session it forks: `ANTHROPIC_CUSTOM_HEADERS` replaces Claude
//    Code's own `X-Claude-Code-Session-Id`, so a gateway with session affinity sends it to the
//    account that holds the session's cache (checked on 2.1.316).
// 2. The fork keeps the cache key and resends no instruction file that changed during the
//    session, with `CLAUDE_CODE_DISABLE_CLAUDE_MDS` (checked on 2.1.318).
// 3. The fork leaves the session as it was: the agent's next request carries none of the fork's
//    turn, so warm-ups leave nothing in the transcript (`persistSession: false`).
import { execFileSync } from "node:child_process";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { DEFAULT_CACHE_WARM_PING_PROMPT } from "@getpaseo/protocol/agent-cache-warm";
import { afterAll, describe, expect, test } from "vitest";
import type { AgentSession } from "../../agent-sdk-types.js";
import { collectSessionTurnEvents } from "../test-utils/session-stream-adapter.js";
import { ClaudeAgentClient } from "./agent.js";

interface CapturedRequest {
  messages: Array<{ role: string; content: unknown }>;
  system: unknown;
  tools: unknown;
  headers: IncomingHttpHeaders;
}

function requestText(request: CapturedRequest): string {
  return JSON.stringify(request.messages);
}

/**
 * The history with cache breakpoints removed. Claude Code moves `cache_control` to the newest
 * blocks on every request, and a breakpoint is not part of the cached prefix; string and
 * one-text-block content are the same tokens.
 */
function withoutBreakpoints(messages: CapturedRequest["messages"]): unknown {
  return JSON.parse(
    JSON.stringify(messages, (key, value: unknown) =>
      key === "cache_control" ? undefined : value,
    ),
    (_key, value: unknown) =>
      Array.isArray(value) &&
      value.length === 1 &&
      value[0]?.type === "text" &&
      Object.keys(value[0]).length === 2
        ? value[0].text
        : value,
  );
}

interface Stub {
  requests: CapturedRequest[];
  baseUrl: string;
  close(): Promise<void>;
}

/** A Messages API that answers every request "ok" with a cache read, and records it. */
async function startMessagesStub(): Promise<Stub> {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    const parsed = JSON.parse(body) as Omit<CapturedRequest, "headers">;
    requests.push({ ...parsed, headers: request.headers });
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
  return {
    requests,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface Fixture {
  cwd: string;
  claudeMd: string;
  stub: Stub;
  client: ClaudeAgentClient;
  session: AgentSession;
  close(): Promise<void>;
}

async function startSession(): Promise<Fixture> {
  const cwd = await mkdtemp(path.resolve(".claude-cache-warm-fork-"));
  const configDir = path.join(cwd, "config");
  await mkdir(configDir);
  await writeFile(path.join(configDir, "settings.json"), "{}");
  const claudeMd = path.join(cwd, "CLAUDE.md");
  await writeFile(claudeMd, "# Project\n\n- the first rule\n");
  const stub = await startMessagesStub();
  const client = new ClaudeAgentClient({
    logger: pino({ level: "silent" }),
    runtimeSettings: {
      env: {
        ANTHROPIC_BASE_URL: stub.baseUrl,
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
  const started: Fixture = {
    cwd,
    claudeMd,
    stub,
    client,
    session,
    async close() {
      try {
        await started.session.close();
      } finally {
        try {
          await stub.close();
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      }
    },
  };
  return started;
}

async function runTurn(fixture: Fixture, prompt: string): Promise<CapturedRequest> {
  await collectSessionTurnEvents(fixture.session, prompt, { signal: AbortSignal.timeout(30_000) });
  return fixture.stub.requests.at(-1)!;
}

async function warm(fixture: Fixture): Promise<CapturedRequest> {
  const before = fixture.stub.requests.length;
  await expect(fixture.session.warmPromptCache!()).resolves.toMatchObject({ readTokens: 1_000 });
  const fork = fixture.stub.requests.slice(before).at(-1);
  if (!fork) throw new Error("The warm-up fork sent no request");
  return fork;
}

/** The Claude Code this run checks, named in every test so a failure says which version broke. */
const CLAUDE_CODE_VERSION = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();

let fixtures: Fixture[] = [];
afterAll(async () => {
  await Promise.allSettled(fixtures.map((fixture) => fixture.close()));
  fixtures = [];
});

async function openFixture(): Promise<Fixture> {
  const started = await startSession();
  fixtures.push(started);
  return started;
}

describe(`v2 warm-up contract on Claude Code ${CLAUDE_CODE_VERSION}`, () => {
  test("contract 1: the warm-up fork names the session it forks in X-Claude-Code-Session-Id", async () => {
    const current = await openFixture();
    const agentRequest = await runTurn(current, "say ok");
    const sessionId = current.session.id;
    expect(sessionId).toBeTruthy();
    expect(agentRequest.headers["x-claude-code-session-id"]).toBe(sessionId);

    const fork = await warm(current);
    // One header, the session's: Claude Code would otherwise send the fork's own new session id.
    expect(fork.headers["x-claude-code-session-id"]).toBe(sessionId);
  }, 90_000);

  // A warm-up fork is a fresh Claude Code process resuming the session. On start it re-reads the
  // instruction files (CLAUDE.md, auto-memory) and appends every one that changed since the
  // session's copy, in full, to its prompt. The agent's own process sends nothing of the kind, so
  // those tokens are written to the cache on every warm-up and never read again.
  test("contract 2: a warm-up fork keeps the cache key and does not resend changed instruction files", async () => {
    const current = await openFixture();
    const agentRequest = await runTurn(current, "say ok");
    expect(requestText(agentRequest)).toContain("the first rule");

    await appendFile(current.claudeMd, "- a rule added while the agent ran\n");
    const fork = await warm(current);

    // The fork keeps the cache key: same system prompt, tools and history as the agent's request.
    expect(fork.system).toEqual(agentRequest.system);
    expect(fork.tools).toEqual(agentRequest.tools);
    expect(fork.messages[0]).toEqual(agentRequest.messages[0]);
    // And sends no fresh copy of the changed instruction file.
    expect(requestText(fork)).not.toContain("a rule added while the agent ran");
    expect(requestText(fork)).not.toContain("these differ from their earlier copies");
  }, 90_000);

  test("contract 3: a warm-up fork leaves nothing in the session the agent resumes", async () => {
    const current = await openFixture();
    const first = await runTurn(current, "say ok");
    const fork = await warm(current);
    const ping = DEFAULT_CACHE_WARM_PING_PROMPT.slice(0, 20);
    expect(requestText(fork)).toContain(ping);

    // A relaunch reads the session back from its transcript, where a fork that wrote to it shows.
    const handle = current.session.describePersistence();
    if (!handle) throw new Error("The session has no persistence handle");
    await current.session.close();
    current.session = await current.client.resumeSession(handle);
    const next = await runTurn(current, "say ok again");
    expect(requestText(next)).not.toContain(ping);
    // The session's history carries on from its own last request.
    expect(withoutBreakpoints(next.messages.slice(0, first.messages.length))).toEqual(
      withoutBreakpoints(first.messages),
    );
  }, 90_000);
});
