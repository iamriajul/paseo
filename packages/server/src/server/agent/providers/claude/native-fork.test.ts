import { describe, expect, it, vi } from "vitest";
import { forkClaudeSessionAtMessage, resolveNativeForkTarget } from "./native-fork.js";

describe("resolveNativeForkTarget", () => {
  it("returns the transcript uuid the session resolves the boundary to", async () => {
    const session = {
      resolveNativeForkUpToMessageId: vi.fn(async () => "uuid-assistant-1"),
    };
    const result = await resolveNativeForkTarget({
      session,
      boundaryMessageId: "msg_011CdokQULJhdFpNj63Pcv83",
    });
    expect(result).toBe("uuid-assistant-1");
    expect(session.resolveNativeForkUpToMessageId).toHaveBeenCalledWith(
      "msg_011CdokQULJhdFpNj63Pcv83",
    );
  });

  it("throws instead of silently forwarding the raw boundary when the session cannot resolve native fork ids", async () => {
    const session = {};
    await expect(
      resolveNativeForkTarget({
        session,
        boundaryMessageId: "msg_011CdokQULJhdFpNj63Pcv83",
      }),
    ).rejects.toThrow(/does not support native fork/i);
  });

  it("throws instead of forwarding an unresolved API message id to the SDK", async () => {
    const session = {
      resolveNativeForkUpToMessageId: vi.fn(async () => "msg_011CdokQULJhdFpNj63Pcv83"),
    };
    await expect(
      resolveNativeForkTarget({
        session,
        boundaryMessageId: "msg_011CdokQULJhdFpNj63Pcv83",
      }),
    ).rejects.toThrow(/could not resolve/i);
  });
});

describe("forkClaudeSessionAtMessage", () => {
  it("returns forked session id without requiring setSessionId on source", async () => {
    const sdk = {
      forkSession: vi.fn(async () => ({ sessionId: "forked-1" })),
    };
    const result = await forkClaudeSessionAtMessage({
      sdk,
      sessionId: "source-1",
      upToMessageId: "uuid-9",
      dir: "/tmp/project",
    });
    expect(result.forkedSessionId).toBe("forked-1");
    expect(sdk.forkSession).toHaveBeenCalledWith("source-1", {
      upToMessageId: "uuid-9",
      dir: "/tmp/project",
    });
  });

  it("rejects empty session id", async () => {
    await expect(
      forkClaudeSessionAtMessage({
        sdk: { forkSession: vi.fn() },
        sessionId: "  ",
        upToMessageId: "msg-9",
      }),
    ).rejects.toThrow(/not ready/i);
  });

  it("rejects empty boundary message id", async () => {
    await expect(
      forkClaudeSessionAtMessage({
        sdk: { forkSession: vi.fn() },
        sessionId: "source-1",
        upToMessageId: "",
      }),
    ).rejects.toThrow(/boundary message/i);
  });
});
