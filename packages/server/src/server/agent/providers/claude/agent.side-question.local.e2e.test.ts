// Side questions on the Claude Code the daemon launches, against a local stub of the Messages API.
// No model, gateway or account is involved, and the stub is the only thing the CLI talks to.
//
// 1. Read-only, whatever the source allows. The source runs in bypassPermissions with settings
//    rules allowing Bash, Write and Edit. A side question forked from it is asked to write a file
//    and to run a command: nothing changes on disk and both calls fail with "Side questions are
//    read-only." The same script run by the source itself does change the disk, so the block is
//    the side question's and not the fixture's.
// 2. The cache is reused. The side question's first request starts with the source's whole last
//    request (system, tools, history) and names the source's session in
//    X-Claude-Code-Session-Id, so a gateway sends it to the account that holds the cache.
//    The system prompt does not mention side questions: the notice rides in the first prompt.
// 3. An earlier point forks only up to the chosen reply.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { afterAll, describe, expect, test } from "vitest";
import { AgentManager } from "../../agent-manager.js";
import { AgentStorage } from "../../agent-storage.js";
import { sendPromptToAgent } from "../../agent-prompt.js";
import { SIDE_QUESTION_DENY_MESSAGE } from "./side-question-policy.js";
import { ClaudeAgentClient } from "./agent.js";

interface CapturedRequest {
  messages: Array<{ role: string; content: unknown }>;
  system: unknown;
  tools: unknown;
  headers: IncomingHttpHeaders;
}

interface ToolUse {
  name: string;
  input: Record<string, unknown>;
}
/** What the stub answers: tool calls when the newest user text names a script, else "ok". */
type Script = Map<string, ToolUse[]>;

/** Claude Code appends `system`-role reminders, so the newest user turn is not always last. */
function lastUserMessage(request: CapturedRequest) {
  return request.messages.findLast((message) => message.role === "user");
}

function lastUserText(request: CapturedRequest): string {
  const last = lastUserMessage(request);
  if (!last) return "";
  const content = last.content;
  if (typeof content === "string") return content;
  return (content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

function toolResults(request: CapturedRequest): Array<{ is_error?: boolean; content: unknown }> {
  const last = lastUserMessage(request);
  if (!last || !Array.isArray(last.content)) return [];
  return (last.content as Array<{ type: string; is_error?: boolean; content: unknown }>).filter(
    (block) => block.type === "tool_result",
  );
}

function withoutBreakpoints(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, inner: unknown) => (key === "cache_control" ? undefined : inner)),
    (_key, inner: unknown) =>
      Array.isArray(inner) &&
      inner.length === 1 &&
      inner[0]?.type === "text" &&
      Object.keys(inner[0]).length === 2
        ? inner[0].text
        : inner,
  );
}

interface Stub {
  requests: CapturedRequest[];
  baseUrl: string;
  script: Script;
  close(): Promise<void>;
}

async function startMessagesStub(): Promise<Stub> {
  const requests: CapturedRequest[] = [];
  const script: Script = new Map();
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    const parsed = JSON.parse(body) as Omit<CapturedRequest, "headers">;
    const captured: CapturedRequest = { ...parsed, headers: request.headers };
    requests.push(captured);
    const marker = [...script.keys()].find((key) => lastUserText(captured).includes(key));
    const calls = marker ? script.get(marker)! : [];
    response.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (data: { type: string; [key: string]: unknown }) => {
      response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    emit({
      type: "message_start",
      message: {
        id: `msg_stub_${requests.length}`,
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
    calls.forEach((call, index) => {
      emit({
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: `toolu_${requests.length}_${index}`,
          name: call.name,
          input: {},
        },
      });
      emit({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
      });
      emit({ type: "content_block_stop", index });
    });
    if (calls.length === 0) {
      emit({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      emit({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
      emit({ type: "content_block_stop", index: 0 });
    }
    emit({
      type: "message_delta",
      delta: { stop_reason: calls.length > 0 ? "tool_use" : "end_turn", stop_sequence: null },
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
    script,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const logger = pino({ level: "silent" });
const CLAUDE_CODE_VERSION = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();

interface Fixture {
  cwd: string;
  stub: Stub;
  manager: AgentManager;
  storage: AgentStorage;
  sourceId: string;
  close(): Promise<void>;
}

let fixtures: Fixture[] = [];
afterAll(async () => {
  await Promise.allSettled(fixtures.map((fixture) => fixture.close()));
  fixtures = [];
});

/** A source agent in bypassPermissions whose settings allow Bash, Write and Edit. */
async function openFixture(): Promise<Fixture> {
  const cwd = await mkdtemp(path.resolve(".claude-side-question-"));
  const configDir = path.join(cwd, "config");
  await mkdir(configDir);
  await writeFile(path.join(configDir, "settings.json"), "{}");
  await writeFile(path.join(cwd, "CLAUDE.md"), "# Project\n\n- the first rule\n");
  const stub = await startMessagesStub();
  const storage = new AgentStorage(path.join(cwd, "agents"), logger);
  const client = new ClaudeAgentClient({
    logger,
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
  const manager = new AgentManager({ clients: { claude: client }, registry: storage, logger });
  const source = await manager.createAgent(
    {
      provider: "claude",
      cwd,
      model: "claude-haiku-5-5",
      modeId: "bypassPermissions",
      featureValues: { prompt_cache_ttl: "5m" },
      providerOptions: {
        settings: { permissions: { allow: ["Bash(*)", "Write(*)", "Edit(*)"] } },
      },
    },
    undefined,
    { workspaceId: "ws-1" },
  );
  const started: Fixture = {
    cwd,
    stub,
    manager,
    storage,
    sourceId: source.id,
    async close() {
      try {
        await manager.closeAgent(source.id);
      } finally {
        try {
          await stub.close();
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      }
    },
  };
  fixtures.push(started);
  return started;
}

function assistantReplyIds(fixture: Fixture, agentId: string): string[] {
  return fixture.manager
    .fetchTimeline(agentId, { direction: "tail", limit: 0 })
    .rows.flatMap((row) =>
      row.item.type === "assistant_message" && row.item.messageId ? [row.item.messageId] : [],
    );
}

/** Sends through the daemon's own prompt path, then waits for the turn's final reply. */
async function ask(fixture: Fixture, agentId: string, prompt: string): Promise<void> {
  const seen = new Set(assistantReplyIds(fixture, agentId));
  await sendPromptToAgent({
    agentManager: fixture.manager,
    agentStorage: fixture.storage,
    agentId,
    prompt,
    logger,
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const replied = assistantReplyIds(fixture, agentId).some((id) => !seen.has(id));
    if (replied && fixture.manager.getAgent(agentId)?.lifecycle === "idle") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`The agent did not finish answering "${prompt}"`);
}

describe(`side questions on Claude Code ${CLAUDE_CODE_VERSION}`, () => {
  test("a side question cannot write a file or run a command, even when its source can", async () => {
    const fixture = await openFixture();
    const sideWrite = path.join(fixture.cwd, "side-question-wrote.txt");
    const sideTouched = path.join(fixture.cwd, "side-question-ran");
    const sourceWrite = path.join(fixture.cwd, "source-wrote.txt");
    const sourceTouched = path.join(fixture.cwd, "source-ran");
    const script = (write: string, touched: string): ToolUse[] => [
      { name: "Write", input: { file_path: write, content: "changed" } },
      { name: "Bash", input: { command: `touch ${touched}`, description: "touch" } },
    ];
    fixture.stub.script.set("SCRIPT-SOURCE", script(sourceWrite, sourceTouched));
    fixture.stub.script.set("SCRIPT-SIDE", script(sideWrite, sideTouched));

    await ask(fixture, fixture.sourceId, "say ok");
    // Control: the same two calls from the source change the disk.
    await ask(fixture, fixture.sourceId, "SCRIPT-SOURCE");
    expect(existsSync(sourceWrite)).toBe(true);
    expect(existsSync(sourceTouched)).toBe(true);

    const { agentId } = await fixture.manager.openSideQuestion({ sourceAgentId: fixture.sourceId });
    const before = fixture.stub.requests.length;
    await ask(fixture, agentId, "SCRIPT-SIDE");

    expect(existsSync(sideWrite)).toBe(false);
    expect(existsSync(sideTouched)).toBe(false);
    // The model was told, on its next request, that both calls failed.
    const followUp = fixture.stub.requests
      .slice(before)
      .find((request) => toolResults(request).length === 2);
    expect(followUp).toBeDefined();
    for (const result of toolResults(followUp!)) {
      expect(result.is_error).toBe(true);
      expect(JSON.stringify(result.content)).toContain(SIDE_QUESTION_DENY_MESSAGE);
    }
    // The session behind it is in default mode whatever its source runs in.
    expect(fixture.manager.getAgent(agentId)?.config.modeId).toBe("default");
  }, 180_000);

  test("its first request reuses the source's whole prompt: same system, tools, history and account", async () => {
    const fixture = await openFixture();
    await ask(fixture, fixture.sourceId, "say ok");
    const sourceRequest = fixture.stub.requests.at(-1)!;
    const sourceSessionId = fixture.manager.getAgent(fixture.sourceId)?.persistence?.sessionId;
    expect(sourceRequest.headers["x-claude-code-session-id"]).toBe(sourceSessionId);

    const { agentId } = await fixture.manager.openSideQuestion({ sourceAgentId: fixture.sourceId });
    const before = fixture.stub.requests.length;
    await ask(fixture, agentId, "why ok?");
    const sideRequest = fixture.stub.requests.slice(before)[0]!;

    expect(sideRequest.system).toEqual(sourceRequest.system);
    expect(sideRequest.tools).toEqual(sourceRequest.tools);
    // The source's request, plus its reply, is the front of the side question's request.
    const front = sideRequest.messages.slice(0, sourceRequest.messages.length + 1);
    expect(withoutBreakpoints(front.slice(0, sourceRequest.messages.length))).toEqual(
      withoutBreakpoints(sourceRequest.messages),
    );
    expect(front.at(-1)?.role).toBe("assistant");
    // The side question names the source's session, so a gateway routes it to the cached account.
    expect(sideRequest.headers["x-claude-code-session-id"]).toBe(sourceSessionId);
    // The notice rides in the new prompt, not the system prompt.
    expect(JSON.stringify(sideRequest.system)).not.toMatch(/side question/i);
    const asked = lastUserText(sideRequest);
    expect(asked).toContain("This is a side question");
    expect(asked).toContain("why ok?");
    // The timeline shows the user's own words.
    const timeline = fixture.manager.fetchTimeline(agentId, { direction: "tail", limit: 0 });
    const userTexts = timeline.rows.flatMap((row) =>
      row.item.type === "user_message" ? [row.item.text] : [],
    );
    expect(userTexts.at(-1)).toBe("why ok?");

    // A follow-up continues the side question's own prompt: the notice is not sent twice.
    const beforeFollowUp = fixture.stub.requests.length;
    await ask(fixture, agentId, "and the second part?");
    const followUp = fixture.stub.requests.slice(beforeFollowUp)[0]!;
    expect(lastUserText(followUp)).toContain("and the second part?");
    expect(lastUserText(followUp)).not.toContain("This is a side question");
    expect(JSON.stringify(followUp.messages.slice(0, sideRequest.messages.length))).toContain(
      "This is a side question",
    );
  }, 120_000);

  test("an earlier point forks only up to the chosen reply", async () => {
    const fixture = await openFixture();
    await ask(fixture, fixture.sourceId, "first turn");
    const firstReply = fixture.manager
      .fetchTimeline(fixture.sourceId, { direction: "tail", limit: 0 })
      .rows.findLast((row) => row.item.type === "assistant_message");
    const boundaryMessageId =
      firstReply?.item.type === "assistant_message" ? firstReply.item.messageId : undefined;
    expect(boundaryMessageId).toBeTruthy();
    await ask(fixture, fixture.sourceId, "second turn, later");

    const { agentId } = await fixture.manager.openSideQuestion({
      sourceAgentId: fixture.sourceId,
      boundaryMessageId,
    });
    const before = fixture.stub.requests.length;
    await ask(fixture, agentId, "about the first one");
    const sideRequest = fixture.stub.requests.slice(before)[0]!;

    const text = JSON.stringify(sideRequest.messages);
    expect(text).toContain("first turn");
    expect(text).not.toContain("second turn, later");
    expect(fixture.manager.getAgent(agentId)?.labels["paseo.side-question-point"]).toBe("earlier");
  }, 150_000);
});
