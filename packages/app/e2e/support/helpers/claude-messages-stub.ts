import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface StubRequest {
  messages: Array<{ role: string; content: unknown }>;
  system: unknown;
  headers: IncomingHttpHeaders;
}

export interface StubToolUse {
  name: string;
  input: Record<string, unknown>;
}

export interface ClaudeMessagesStub {
  requests: StubRequest[];
  /** Environment for a daemon whose Claude Code talks only to this stub. */
  environment: Record<string, string>;
  /** Makes a prompt containing `marker` answer with these tool calls. */
  script(marker: string, calls: StubToolUse[]): void;
  /** What the newest user turn of a request says. */
  lastUserText(request: StubRequest): string;
  close(): Promise<void>;
}

function userText(request: Pick<StubRequest, "messages">): string {
  const last = request.messages.findLast((message) => message.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  return (last.content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

function hasToolResult(request: Pick<StubRequest, "messages">): boolean {
  const last = request.messages.findLast((message) => message.role === "user");
  return (
    Array.isArray(last?.content) &&
    (last.content as Array<{ type: string }>).some((block) => block.type === "tool_result")
  );
}

/** What the model "answers": the prompt it received, so a test can see what reached it. */
function replyTo(text: string): string {
  if (text.includes("Raise the relay wake threshold")) {
    return [
      "Done. The threshold is now `relay.wakeDriftMs` in the host config, default 45000, minimum 5000.",
      "",
      "The old session keys are discarded on purpose.",
    ].join("\n");
  }
  return `Got it. This is the prompt I received:\n\n\`\`\`\n${text.slice(0, 1_200)}\n\`\`\``;
}

/**
 * A local Messages API that answers every request over SSE and records it, so a daemon's real
 * Claude Code can run in a test with no model, gateway or account.
 */
export async function startClaudeMessagesStub(): Promise<ClaudeMessagesStub> {
  const requests: StubRequest[] = [];
  const scripts = new Map<string, StubToolUse[]>();
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    const parsed = JSON.parse(body) as Omit<StubRequest, "headers">;
    const captured: StubRequest = { ...parsed, headers: request.headers };
    requests.push(captured);
    const text = userText(captured);
    const marker = [...scripts.keys()].find((key) => text.includes(key));
    // A tool result means the scripted calls already ran; the next answer is plain text.
    const calls = marker && !hasToolResult(captured) ? scripts.get(marker)! : [];
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
          cache_read_input_tokens: 40_000,
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
      emit({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: hasToolResult(captured) ? "Blocked, as expected." : replyTo(text),
        },
      });
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
  if (!address || typeof address === "string") throw new Error("The stub has no TCP address");
  const configRoot = await mkdtemp(path.join(tmpdir(), "paseo-e2e-claude-stub-"));
  const configDir = path.join(configRoot, "config");
  await mkdir(configDir);
  await writeFile(path.join(configDir, "settings.json"), "{}");
  return {
    requests,
    lastUserText: userText,
    script(marker, calls) {
      scripts.set(marker, calls);
    },
    environment: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      ANTHROPIC_AUTH_TOKEN: "fixture-token",
      ANTHROPIC_API_KEY: "",
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(configRoot, { recursive: true, force: true });
    },
  };
}
