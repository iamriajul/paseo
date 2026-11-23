import { describe, expect, test } from "vitest";
import { projectAgentMessages } from "./envelope.js";
import {
  SIDE_QUESTION_NOTICE,
  stripSideQuestionNotice,
  withSideQuestionNotice,
} from "./side-question-notice.js";

describe("side question notice", () => {
  test("wraps a text prompt in a paseo-system envelope ahead of the question", () => {
    const wrapped = withSideQuestionNotice("Why did you pick Redis?") as string;
    expect(wrapped.startsWith('<paseo-system version="1" kind="side-question">\n')).toBe(true);
    expect(wrapped).toContain(SIDE_QUESTION_NOTICE);
    expect(wrapped.endsWith("</paseo-system>\nWhy did you pick Redis?")).toBe(true);
  });

  test("tells the model what is blocked and that the main session will not see this", () => {
    expect(SIDE_QUESTION_NOTICE).toMatch(/main session continues separately and will not see/);
    expect(SIDE_QUESTION_NOTICE).toMatch(/do not continue the task/i);
    expect(SIDE_QUESTION_NOTICE).toMatch(
      /changes files, runs commands or contacts other agents is blocked/,
    );
  });

  test("goes in the first text block of a block prompt and keeps images", () => {
    const wrapped = withSideQuestionNotice([
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "text", text: "what is in this?" },
    ]);
    expect(Array.isArray(wrapped)).toBe(true);
    const blocks = wrapped as Array<{ type: string; text?: string }>;
    expect(blocks[0]).toMatchObject({ type: "image" });
    expect(stripSideQuestionNotice(blocks[1]?.text ?? "")).toBe("what is in this?");
  });

  test("strips only a notice at the start", () => {
    expect(stripSideQuestionNotice("plain text")).toBeNull();
    expect(stripSideQuestionNotice(`> ${withSideQuestionNotice("x") as string}`)).toBeNull();
  });

  test("the timeline shows the user's own text, from the live echo and from replay alike", () => {
    const echoed = {
      type: "user_message" as const,
      text: withSideQuestionNotice("Why did you pick Redis?") as string,
      clientMessageId: "client-1",
    };
    expect(projectAgentMessages(echoed)).toEqual([
      { type: "user_message", text: "Why did you pick Redis?", clientMessageId: "client-1" },
    ]);
  });
});
