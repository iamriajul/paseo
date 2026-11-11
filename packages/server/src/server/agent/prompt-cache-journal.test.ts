import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pino from "pino";
import { mkdtempSync, rmSync, appendFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentPromptCacheState,
  PromptCacheHistoryEntry,
} from "@getpaseo/protocol/agent-cache-warm";
import { PromptCacheJournal } from "./prompt-cache-journal.js";

function entry(at: string, readTokens: number): PromptCacheHistoryEntry {
  return { at, kind: "request", readTokens, writeTokens: 10, uncachedTokens: 1, gapMs: 1000 };
}

describe("PromptCacheJournal", () => {
  let directory: string;
  let journal: PromptCacheJournal;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "prompt-cache-journal-"));
    journal = new PromptCacheJournal({ directory, logger: pino({ level: "silent" }) });
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps every request, past any snapshot window, in order", async () => {
    for (let index = 0; index < 100; index += 1) {
      const at = new Date(Date.UTC(2026, 10, 1, 10, 0, index)).toISOString();
      void journal.appendRequest({ agentId: "a", entry: entry(at, index), before: undefined });
    }
    const history = await journal.read("a");
    expect(history?.requests.map((request) => request.readTokens)).toEqual(
      Array.from({ length: 100 }, (_, index) => index),
    );
  });

  it("keeps CLIProxyAPI account changes apart from requests and compactions", async () => {
    void journal.appendRequest({
      agentId: "a",
      entry: entry("2026-11-01T10:00:00.000Z", 5),
      before: undefined,
    });
    void journal.appendAccount({
      agentId: "a",
      account: {
        at: "2026-11-01T10:00:02.000Z",
        account: "B",
        from: "A",
        reason: "quota",
        missAt: "2026-11-01T10:00:03.000Z",
      },
      before: undefined,
    });

    const history = await journal.read("a");

    expect(history?.requests).toHaveLength(1);
    expect(history?.compactions).toEqual([]);
    expect(history?.accounts).toEqual([
      {
        at: "2026-11-01T10:00:02.000Z",
        account: "B",
        from: "A",
        reason: "quota",
        missAt: "2026-11-01T10:00:03.000Z",
      },
    ]);
  });

  it("keeps why each warm-up stopped, apart from everything else", async () => {
    void journal.appendRequest({
      agentId: "a",
      entry: entry("2026-11-01T10:00:00.000Z", 5),
      before: undefined,
    });
    const stop = {
      at: "2026-11-01T10:04:00.000Z",
      reason: "quota",
      account: "s***b",
      window: "5h",
      until: "2026-11-01T14:05:00.000Z",
    };
    void journal.appendWarmUpStop({ agentId: "a", stop, before: undefined });

    const history = await journal.read("a");

    expect(history?.requests).toHaveLength(1);
    expect(history?.accounts).toEqual([]);
    expect(history?.warmUpStops).toEqual([stop]);
  });

  it("starts an existing agent's journal from its snapshot history", async () => {
    const before: AgentPromptCacheState = {
      lastRequest: {
        at: "2026-11-01T10:00:01.000Z",
        turnId: "t",
        isWarmPing: false,
        readTokens: 2,
        writeTokens: 0,
        uncachedTokens: 0,
      },
      turnFirstRequest: {
        at: "2026-11-01T10:00:00.000Z",
        turnId: "t",
        isWarmPing: false,
        readTokens: 1,
        writeTokens: 0,
        uncachedTokens: 0,
      },
      history: [entry("2026-11-01T10:00:00.000Z", 1), entry("2026-11-01T10:00:01.000Z", 2)],
      compactions: [{ at: "2026-11-01T10:00:00.500Z", trigger: "manual" }],
    };
    await journal.appendRequest({
      agentId: "a",
      entry: entry("2026-11-01T10:00:02.000Z", 3),
      before,
    });
    await journal.appendRequest({
      agentId: "a",
      entry: entry("2026-11-01T10:00:03.000Z", 4),
      before,
    });
    const history = await journal.read("a");
    expect(history?.requests.map((request) => request.readTokens)).toEqual([1, 2, 3, 4]);
    expect(history?.compactions).toEqual([{ at: "2026-11-01T10:00:00.500Z", trigger: "manual" }]);
  });

  it("reads past a line torn by a crash", async () => {
    await journal.appendRequest({
      agentId: "a",
      entry: entry("2026-11-01T10:00:00.000Z", 1),
      before: undefined,
    });
    const [file] = readdirSync(directory);
    appendFileSync(join(directory, file ?? ""), '{"type":"request","at":"2026-11-01T10:0');
    const history = await journal.read("a");
    expect(history?.requests).toHaveLength(1);
  });

  it("has nothing for an agent it never saw, and forgets a deleted one", async () => {
    expect(await journal.read("missing")).toBeNull();
    await journal.appendCompaction({
      agentId: "a",
      compaction: { at: "2026-11-01T10:00:00.000Z", trigger: "auto", preTokens: 180_000 },
      before: undefined,
    });
    expect((await journal.read("a"))?.compactions).toHaveLength(1);
    await journal.delete("a");
    expect(await journal.read("a")).toBeNull();
  });
});
