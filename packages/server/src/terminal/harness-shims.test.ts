import { describe, expect, it } from "vitest";
import {
  CLIPROXYAPI_SHIM_DISABLE_ENV,
  buildHarnessShimEnv,
  isShimmedHarness,
  terminalHarnessGatewayEnv,
} from "./harness-shims.js";
import type { ResolvedGatewayConfig } from "../server/agent/gateway/config.js";

const gateway: ResolvedGatewayConfig = {
  baseUrl: "http://cpa.test:8317",
  apiKey: "sk-test",
};

describe("buildHarnessShimEnv", () => {
  it("gives Claude gateway env plus the discovery flag", () => {
    const { env, argv } = buildHarnessShimEnv("claude", gateway);
    expect(env.ANTHROPIC_BASE_URL).toBe("http://cpa.test:8317");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-test");
    expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
    expect(argv).toEqual([]);
  });

  it("gives Codex OpenAI env and a model_providers map via argv", () => {
    const { env, argv } = buildHarnessShimEnv("codex", gateway);
    expect(env.OPENAI_BASE_URL).toBe("http://cpa.test:8317/v1");
    expect(env.OPENAI_API_KEY).toBe("sk-test");

    const joined = argv.join(" ");
    expect(joined).toContain('model_providers.cliproxyapi.base_url="http://cpa.test:8317/v1"');
    // Codex 0.159 rejects wire_api="chat"; must match the agent path.
    expect(joined).toContain('model_providers.cliproxyapi.wire_api="responses"');
    expect(joined).not.toContain('wire_api="chat"');
    // Without this header CLIProxyAPI drops ChatGPT-parity tool calls.
    expect(joined).toContain("X-OpenAI-Actor-Authorization");
    expect(joined).toContain("requires_openai_auth=false");
  });

  it("gives OpenCode a bare provider record, not a whole config document", () => {
    const { env } = buildHarnessShimEnv("opencode", gateway);
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    // The record is the document. Emitting {provider:{…}} instead would make
    // OpenCode's own merge replace a user's existing provider map, so this
    // asserts the absence of that wrapper as much as the record's presence.
    expect(config.provider).toBeUndefined();
    expect(config.cliproxyapi.npm).toBe("@ai-sdk/openai-compatible");
    expect(config.cliproxyapi.options.baseURL).toBe("http://cpa.test:8317/v1");
    expect(config.cliproxyapi.options.apiKey).toBe("sk-test");
  });

  it("normalizes a base url that already carries /v1", () => {
    const withV1: ResolvedGatewayConfig = { baseUrl: "http://cpa.test:8317/v1", apiKey: "sk" };
    const codex = buildHarnessShimEnv("codex", withV1).argv.join(" ");
    expect(codex).toContain('base_url="http://cpa.test:8317/v1"');
    expect(codex).not.toContain("/v1/v1");
  });

  it("keeps OMP on env rather than shimming it", () => {
    expect(isShimmedHarness("omp")).toBe(false);
    const env = terminalHarnessGatewayEnv(gateway);
    expect(env.LITELLM_BASE_URL).toBe("http://cpa.test:8317/v1");
    expect(env.LITELLM_API_KEY).toBe("sk-test");
  });

  it("exposes a per-invocation opt-out env name", () => {
    expect(CLIPROXYAPI_SHIM_DISABLE_ENV).toBe("PASEO_CLIPROXYAPI_DISABLE_SHIM");
  });
});
