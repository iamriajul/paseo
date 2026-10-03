import { z } from "zod";

import {
  generateMetadataOpenAIStructured,
  isMetadataCustomEndpointReady,
} from "../../agent/metadata-openai-client.js";

export const VOICE_READ_ALOUD_REWRITE_TIMEOUT_MS = 25_000;
const READ_ALOUD_REWRITE_SCHEMA_NAME = "ReadAloudRewrite";

const ReadAloudRewriteOutputSchema = z.object({ text: z.string() });

export interface ReadAloudRewriteEndpointConfig {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export interface RewriteWithCustomEndpointInput {
  text: string;
  endpoint: ReadAloudRewriteEndpointConfig | null | undefined;
  fetchImpl?: typeof fetch;
  generate?: typeof generateMetadataOpenAIStructured;
}

export function buildReadAloudRewritePrompt(text: string): string {
  return [
    "Rewrite the following coding-assistant chat message into natural spoken prose for text-to-speech.",
    "",
    "Rules:",
    "- Describe code by purpose, never recite it verbatim. Summarize what the code does instead of reading symbols, identifiers, or punctuation aloud.",
    "- Expand link text: speak the visible link label and drop bare URLs unless the URL itself is the point.",
    "- Convert markdown structure (headings, lists, emphasis, quotes) into flowing sentences.",
    "- Keep short messages near-verbatim when they are already speakable; only strip formatting that would sound unnatural.",
    "- Emit plain text only: no markdown, no code fences, no bullets, no emoji, no stage directions.",
    "",
    "Message:",
    text,
  ].join("\n");
}

export async function rewriteWithCustomEndpoint(
  input: RewriteWithCustomEndpointInput,
): Promise<{ rewrittenText: string } | { error: { code: string; message: string } }> {
  const endpoint = input.endpoint;
  if (!isMetadataCustomEndpointReady(endpoint)) {
    return {
      error: {
        code: "endpoint_not_configured",
        message: "Custom metadata endpoint is not configured",
      },
    };
  }
  const generate = input.generate ?? generateMetadataOpenAIStructured;
  try {
    const result = await generate({
      baseUrl: endpoint?.baseUrl ?? "",
      ...(endpoint?.apiKey ? { apiKey: endpoint.apiKey } : {}),
      model: endpoint?.model ?? "",
      prompt: buildReadAloudRewritePrompt(input.text),
      schema: ReadAloudRewriteOutputSchema,
      schemaName: READ_ALOUD_REWRITE_SCHEMA_NAME,
      timeoutMs: VOICE_READ_ALOUD_REWRITE_TIMEOUT_MS,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
    return { rewrittenText: result.text };
  } catch (error) {
    return {
      error: {
        code: "rewrite_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
