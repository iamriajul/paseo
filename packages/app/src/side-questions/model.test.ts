import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import {
  canAskSideQuestions,
  describeSideQuestionCost,
  minutesAgo,
  parseBtwCommand,
  selectSideQuestionsOf,
} from "./model";

function agent(input: Partial<Agent> & { id: string; createdAt: Date }): Agent {
  return { labels: {}, archivedAt: null, ...input } as Agent;
}

describe("selectSideQuestionsOf", () => {
  it("lists the unarchived side questions of one chat, oldest first", () => {
    const agents = new Map<string, Agent>([
      [
        "b",
        agent({ id: "b", createdAt: new Date(2000), labels: { "paseo.side-question-of": "main" } }),
      ],
      [
        "a",
        agent({ id: "a", createdAt: new Date(1000), labels: { "paseo.side-question-of": "main" } }),
      ],
      [
        "x",
        agent({
          id: "x",
          createdAt: new Date(1500),
          labels: { "paseo.side-question-of": "other" },
        }),
      ],
      [
        "gone",
        agent({
          id: "gone",
          createdAt: new Date(500),
          archivedAt: new Date(),
          labels: { "paseo.side-question-of": "main" },
        }),
      ],
      ["main", agent({ id: "main", createdAt: new Date(0) })],
    ]);
    expect(selectSideQuestionsOf(agents, "main").map((row) => row.id)).toEqual(["a", "b"]);
  });
});

describe("describeSideQuestionCost", () => {
  it("is quiet when the daemon has nothing to judge by", () => {
    expect(describeSideQuestionCost(null)).toEqual({ kind: "none", confirm: false });
    expect(
      describeSideQuestionCost({
        point: "latest",
        state: "unknown",
        tokens: null,
        expiredAgoMs: null,
      }),
    ).toEqual({ kind: "none", confirm: false });
  });

  it("reads a warm cache without asking", () => {
    expect(
      describeSideQuestionCost({
        point: "latest",
        state: "warm",
        tokens: 412_000,
        expiredAgoMs: null,
      }),
    ).toEqual({ kind: "warm", tokens: 412_000, confirm: false });
  });

  it("asks before rewriting an expired cache, and says how long ago it expired", () => {
    expect(
      describeSideQuestionCost({
        point: "latest",
        state: "expired",
        tokens: 412_000,
        expiredAgoMs: 12 * 60_000,
      }),
    ).toEqual({ kind: "expired", tokens: 412_000, expiredAgoMs: 720_000, confirm: true });
  });

  it("asks before rewriting an earlier point outside the window", () => {
    expect(
      describeSideQuestionCost({
        point: "earlier",
        state: "expired",
        tokens: 180_000,
        expiredAgoMs: 60_000,
      }),
    ).toEqual({ kind: "earlier_expired", tokens: 180_000, confirm: true });
  });
});

describe("parseBtwCommand", () => {
  it("reads /btw with its question", () => {
    expect(parseBtwCommand("/btw why Redis?")).toEqual({ question: "why Redis?" });
    expect(parseBtwCommand("  /btw   two\nlines ")).toEqual({ question: "two\nlines" });
  });
  it("reads a bare /btw as an empty side question", () => {
    expect(parseBtwCommand("/btw")).toEqual({ question: "" });
  });
  it("leaves other text alone", () => {
    expect(parseBtwCommand("/btwx hello")).toBeNull();
    expect(parseBtwCommand("please /btw hello")).toBeNull();
    expect(parseBtwCommand("/compact")).toBeNull();
  });
});

describe("minutesAgo", () => {
  it("rounds, and never says zero", () => {
    expect(minutesAgo(12 * 60_000)).toBe(12);
    expect(minutesAgo(10_000)).toBe(1);
  });
});

describe("canAskSideQuestions", () => {
  const capabilities = { supportsNativeFork: true } as Agent["capabilities"];
  it("offers side questions on a Claude chat that can fork", () => {
    expect(canAskSideQuestions({ provider: "claude", capabilities, labels: {} })).toBe(true);
  });
  it("leaves them out of a Codex chat, which forks but has no read-only side session", () => {
    expect(canAskSideQuestions({ provider: "codex", capabilities, labels: {} })).toBe(false);
  });
  it("leaves them out of a side question", () => {
    expect(
      canAskSideQuestions({
        provider: "claude",
        capabilities,
        labels: { "paseo.side-question-of": "main" },
      }),
    ).toBe(false);
  });
});
