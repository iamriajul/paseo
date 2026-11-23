import type { AgentPromptInput } from "../agent-sdk-types.js";

/**
 * The first prompt of a side question carries a notice in a `paseo-system` envelope, because the
 * system prompt cannot name the session as a side question without rewriting the prompt cache.
 * The notice is advice to the model; the daemon's hook and permission callback are the controls
 * (providers/claude/side-question-policy.ts). The timeline shows only what the user typed.
 */
const OPEN_TAG = '<paseo-system version="1" kind="side-question">\n';
const CLOSE_TAG = "\n</paseo-system>\n";

export const SIDE_QUESTION_NOTICE = [
  "This is a side question, asked on a copy of the conversation above. The main session continues separately and will not see this question or your answer.",
  "Answer the question. Do not continue the task or pick up where the main session left off.",
  'You can read and search files and the web. Every tool that changes files, runs commands or contacts other agents is blocked, and a blocked call fails with "Side questions are read-only."',
].join("\n");

export function formatSideQuestionNotice(): string {
  return `${OPEN_TAG}${SIDE_QUESTION_NOTICE}${CLOSE_TAG}`;
}

/** Puts the notice ahead of the question's first text. */
export function withSideQuestionNotice(prompt: AgentPromptInput): AgentPromptInput {
  const notice = formatSideQuestionNotice();
  if (typeof prompt === "string") return `${notice}${prompt}`;
  const firstText = prompt.findIndex((block) => block.type === "text" && !("mimeType" in block));
  if (firstText < 0) return [{ type: "text", text: notice.trimEnd() }, ...prompt];
  return prompt.map((block, index) =>
    index === firstText && block.type === "text"
      ? { ...block, text: `${notice}${block.text}` }
      : block,
  );
}

/** The question without its notice, or null when the text does not start with one. */
export function stripSideQuestionNotice(text: string): string | null {
  if (!text.startsWith(OPEN_TAG)) return null;
  const end = text.indexOf(CLOSE_TAG, OPEN_TAG.length);
  if (end < 0) return null;
  return text.slice(end + CLOSE_TAG.length);
}
