import { describe, expect, it } from "vitest";
import {
  CLIPROXYAPI_SHIM_DISABLE_ENV,
  buildHarnessShimEnv,
  isShimmedHarness,
  shimConflictEnv,
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

  it("gives OpenCode a config document carrying the record under provider", () => {
    const { env } = buildHarnessShimEnv("opencode", gateway);
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    // OpenCode deep-merges config sources in order, keyed on the schema's
    // top-level names. A bare {cliproxyapi:…} has no `provider` key to merge
    // into, so the provider never registers — the wrapper is required, not
    // cosmetic, and the doc comment in harness-shims.ts records why.
    expect(config.provider.cliproxyapi.npm).toBe("@ai-sdk/openai-compatible");
    expect(config.provider.cliproxyapi.options.baseURL).toBe("http://cpa.test:8317/v1");
    expect(config.provider.cliproxyapi.options.apiKey).toBe("sk-test");
  });

  it("names the env vars that suppress each shim", () => {
    // Whole-harness, so a user's OPENAI_API_KEY is never left pointing at a
    // gateway they did not ask for.
    expect(shimConflictEnv("codex")).toEqual(["OPENAI_BASE_URL", "OPENAI_API_KEY"]);
    expect(shimConflictEnv("claude")).toEqual([
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
    ]);
    expect(shimConflictEnv("opencode")).toEqual(["OPENCODE_CONFIG_CONTENT"]);
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
