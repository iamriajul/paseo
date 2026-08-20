import { looksLikeAnthropicApiMessageId } from "./transcript-message-id.js";
import type { ClaudeRewindSdk } from "./rewind.js";

export interface ClaudeNativeForkSession {
  resolveNativeForkUpToMessageId?(boundaryMessageId: string): Promise<string>;
}

/**
 * Resolve an app-level fork boundary to the transcript UUID the Claude Agent
 * SDK requires for `forkSession({ upToMessageId })`. Never forwards an
 * Anthropic API message id (`msg_…`) to the SDK — it rejects those outright,
 * so an unresolved id fails here with a clear reason instead of the SDK's
 * generic "not a UUID" error.
 */
export async function resolveNativeForkTarget(input: {
  session: ClaudeNativeForkSession;
  boundaryMessageId: string;
}): Promise<string> {
  if (typeof input.session.resolveNativeForkUpToMessageId !== "function") {
    throw new Error("Claude session does not support native fork id resolution");
  }
  const upToMessageId = await input.session.resolveNativeForkUpToMessageId(input.boundaryMessageId);
  if (looksLikeAnthropicApiMessageId(upToMessageId)) {
    throw new Error(
      `Native fork could not resolve ${input.boundaryMessageId} to a transcript UUID ` +
        `(resolver returned ${upToMessageId})`,
    );
  }
  return upToMessageId;
}

/**
 * Fork a Claude provider session at a message boundary without mutating the
 * source agent's session id. The caller must register a *new* agent with the
 * returned forkedSessionId.
 */
export async function forkClaudeSessionAtMessage(input: {
  sdk: ClaudeRewindSdk;
  sessionId: string;
  upToMessageId: string;
  /** Project cwd so the SDK can locate the session transcript. */
  dir?: string;
}): Promise<{ forkedSessionId: string }> {
  if (!input.sessionId.trim()) {
    throw new Error("Claude session is not ready for native fork");
  }
  if (!input.upToMessageId.trim()) {
    throw new Error("Native fork requires a boundary message id");
  }
  const fork = await input.sdk.forkSession(input.sessionId, {
    upToMessageId: input.upToMessageId,
    ...(input.dir?.trim() ? { dir: input.dir.trim() } : {}),
  });
  const forkedSessionId = fork.sessionId?.trim();
  if (!forkedSessionId) {
    throw new Error("Claude forkSession returned an empty session id");
  }
  return { forkedSessionId };
}
