import { describe, expect, test } from "vitest";

import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  VoiceDictationPolishRequestSchema,
  VoiceDictationPolishResponseSchema,
} from "./messages.js";

describe("server_info.features.voiceDictationPolish", () => {
  test("accepts the voiceDictationPolish feature flag", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "host-1",
      features: {
        voiceDictationPolish: true,
      },
    });

    expect(parsed.features?.voiceDictationPolish).toBe(true);
  });

  test("still parses server_info without voiceDictationPolish", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "host-1",
    });

    expect(parsed.features?.voiceDictationPolish).toBeUndefined();
  });
});

describe("voice.dictation.polish RPC", () => {
  test("parses polish request", () => {
    expect(
      VoiceDictationPolishRequestSchema.parse({
        type: "voice.dictation.polish.request",
        text: "hello world",
        requestId: "req-1",
      }),
    ).toMatchObject({
      type: "voice.dictation.polish.request",
      text: "hello world",
      requestId: "req-1",
    });
  });

  test("parses polish success response", () => {
    expect(
      VoiceDictationPolishResponseSchema.parse({
        type: "voice.dictation.polish.response",
        payload: {
          requestId: "req-1",
          polishedText: "Hello world.",
          error: null,
        },
      }),
    ).toMatchObject({
      type: "voice.dictation.polish.response",
      payload: {
        requestId: "req-1",
        polishedText: "Hello world.",
        error: null,
      },
    });
  });

  test("parses polish error response", () => {
    expect(
      VoiceDictationPolishResponseSchema.parse({
        type: "voice.dictation.polish.response",
        payload: {
          requestId: "req-1",
          polishedText: null,
          error: {
            code: "endpoint_not_configured",
            message: "Custom metadata endpoint is not configured",
          },
        },
      }),
    ).toMatchObject({
      type: "voice.dictation.polish.response",
      payload: {
        requestId: "req-1",
        polishedText: null,
        error: { code: "endpoint_not_configured" },
      },
    });
  });

  test("registers polish in session inbound/outbound unions", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "voice.dictation.polish.request",
        text: "hello",
        requestId: "req-2",
      }).type,
    ).toBe("voice.dictation.polish.request");

    expect(
      SessionOutboundMessageSchema.parse({
        type: "voice.dictation.polish.response",
        payload: {
          requestId: "req-2",
          polishedText: "Hello.",
          error: null,
        },
      }).type,
    ).toBe("voice.dictation.polish.response");
  });
});
