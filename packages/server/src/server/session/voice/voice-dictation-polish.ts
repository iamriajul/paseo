import { z } from "zod";

import {
  generateMetadataOpenAIStructured,
  isMetadataCustomEndpointReady,
} from "../../agent/metadata-openai-client.js";

export const VOICE_DICTATION_POLISH_TIMEOUT_MS = 25_000;
const DICTATION_POLISH_SCHEMA_NAME = "DictationPolish";

const DictationPolishOutputSchema = z.object({ text: z.string() });

export interface DictationPolishEndpointConfig {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export interface PolishWithCustomEndpointInput {
  text: string;
  endpoint: DictationPolishEndpointConfig | null | undefined;
  fetchImpl?: typeof fetch;
  generate?: typeof generateMetadataOpenAIStructured;
}

export function buildDictationPolishPrompt(text: string): string {
  return [
    "Clean up the following voice-dictated draft message for sending as a chat message.",
    "",
    "Rules:",
    "- Fix grammar, punctuation, capitalization, and obvious transcription mistakes.",
    "- Remove spoken filler and false starts (um, uh, like, you know) without changing what the user meant.",
    "- Keep it concise: tighten rambling phrasing but do not change the topic or the user's intent.",
    "- Preserve the user's voice and wording choices wherever they are already clear.",
    "- Emit plain chat-ready text only: no markdown headers, no bullets unless the user dictated a list, no quotes around the message, no commentary about the edit.",
    "",
    "Draft:",
    text,
  ].join("\n");
}

export async function polishWithCustomEndpoint(
  input: PolishWithCustomEndpointInput,
): Promise<{ polishedText: string } | { error: { code: string; message: string } }> {
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
      prompt: buildDictationPolishPrompt(input.text),
      schema: DictationPolishOutputSchema,
      schemaName: DICTATION_POLISH_SCHEMA_NAME,
      timeoutMs: VOICE_DICTATION_POLISH_TIMEOUT_MS,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
    return { polishedText: result.text };
  } catch (error) {
    return {
      error: {
        code: "rewrite_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
