import { describe, expect, test } from "vitest";

import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  VoiceReadAloudRewriteRequestSchema,
  VoiceReadAloudRewriteResponseSchema,
} from "./messages.js";

describe("server_info.features.voiceReadAloudRewrite", () => {
  test("accepts the voiceReadAloudRewrite feature flag", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "host-1",
      features: {
        voiceReadAloudRewrite: true,
      },
    });

    expect(parsed.features?.voiceReadAloudRewrite).toBe(true);
  });

  test("still parses server_info without voiceReadAloudRewrite", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "host-1",
      features: {},
    });

    expect(parsed.features?.voiceReadAloudRewrite).toBeUndefined();
  });
});

describe("voice.read_aloud.rewrite RPC", () => {
  test("parses rewrite request", () => {
    expect(
      VoiceReadAloudRewriteRequestSchema.parse({
        type: "voice.read_aloud.rewrite.request",
        text: "Fixed the **login** bug, see [docs](https://example.com/docs).",
        requestId: "req-1",
      }),
    ).toMatchObject({
      type: "voice.read_aloud.rewrite.request",
      text: "Fixed the **login** bug, see [docs](https://example.com/docs).",
      requestId: "req-1",
    });
  });

  test("parses rewrite success response", () => {
    expect(
      VoiceReadAloudRewriteResponseSchema.parse({
        type: "voice.read_aloud.rewrite.response",
        payload: {
          requestId: "req-1",
          rewrittenText: "Fixed the login bug, see the docs.",
          error: null,
        },
      }),
    ).toMatchObject({
      type: "voice.read_aloud.rewrite.response",
      payload: {
        requestId: "req-1",
        rewrittenText: "Fixed the login bug, see the docs.",
        error: null,
      },
    });
  });

  test("parses rewrite error response", () => {
    expect(
      VoiceReadAloudRewriteResponseSchema.parse({
        type: "voice.read_aloud.rewrite.response",
        payload: {
          requestId: "req-1",
          rewrittenText: null,
          error: { code: "endpoint_not_configured", message: "Custom endpoint is not configured" },
        },
      }),
    ).toMatchObject({
      type: "voice.read_aloud.rewrite.response",
      payload: {
        rewrittenText: null,
        error: { code: "endpoint_not_configured" },
      },
    });
  });

  test("registers rewrite in session inbound/outbound unions", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "voice.read_aloud.rewrite.request",
        text: "hello",
        requestId: "req-2",
      }).type,
    ).toBe("voice.read_aloud.rewrite.request");

    expect(
      SessionOutboundMessageSchema.parse({
        type: "voice.read_aloud.rewrite.response",
        payload: {
          requestId: "req-2",
          rewrittenText: "hello",
          error: null,
        },
      }).type,
    ).toBe("voice.read_aloud.rewrite.response");
  });
});
