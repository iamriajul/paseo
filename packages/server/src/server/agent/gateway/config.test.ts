import { describe, expect, test } from "vitest";

import {
  CLIPROXYAPI_ENV_API_KEY,
  CLIPROXYAPI_ENV_BASE_URL,
  GATEWAY_ENV_API_KEY,
  GATEWAY_ENV_BASE_URL,
  claudeGatewayEnv,
  claudeOverrideOptsOutOfGateway,
  codexGatewayEnv,
  codexOverrideOptsOutOfGateway,
  gatewayBaseUrlsMatch,
  ompGatewayEnv,
  ompOverrideOptsOutOfGateway,
  resolveGatewayConfig,
} from "./config.js";

describe("resolveGatewayConfig", () => {
  test("disabled by default", () => {
    expect(resolveGatewayConfig(undefined, {})).toBeNull();
    expect(resolveGatewayConfig({}, {})).toBeNull();
    expect(resolveGatewayConfig({ enabled: false }, {})).toBeNull();
  });

  test("resolves file config when enabled", () => {
    expect(
      resolveGatewayConfig(
        { enabled: true, baseUrl: "http://gateway:8317/", apiKey: "sk-test" },
        {},
      ),
    ).toEqual({ baseUrl: "http://gateway:8317", apiKey: "sk-test" });
  });

  test("strips a trailing /v1 so both URL forms route every harness", () => {
    expect(
      resolveGatewayConfig(
        { enabled: true, baseUrl: "http://gateway:8317/v1", apiKey: "sk-test" },
        {},
      ),
    ).toEqual({ baseUrl: "http://gateway:8317", apiKey: "sk-test" });
    expect(
      resolveGatewayConfig(
        {},
        { [GATEWAY_ENV_BASE_URL]: "http://gateway:8317/v1/", [GATEWAY_ENV_API_KEY]: "sk-test" },
      ),
    ).toEqual({ baseUrl: "http://gateway:8317", apiKey: "sk-test" });
  });

  test("requires both base URL and key", () => {
    expect(resolveGatewayConfig({ enabled: true, baseUrl: "http://gateway:8317" }, {})).toBeNull();
    expect(resolveGatewayConfig({ enabled: true, apiKey: "sk-test" }, {})).toBeNull();
  });

  test("cliproxyapi env wins over the old gateway env and the file", () => {
    expect(
      resolveGatewayConfig(
        { enabled: false, baseUrl: "http://file:8317", apiKey: "sk-file" },
        {
          [CLIPROXYAPI_ENV_BASE_URL]: "http://cliproxyapi:8317",
          [CLIPROXYAPI_ENV_API_KEY]: "sk-cpa",
          [GATEWAY_ENV_BASE_URL]: "http://old:8317",
          [GATEWAY_ENV_API_KEY]: "sk-old",
        },
      ),
    ).toEqual({ baseUrl: "http://cliproxyapi:8317", apiKey: "sk-cpa" });
  });

  test("blank env values do not enable", () => {
    expect(
      resolveGatewayConfig({}, { [GATEWAY_ENV_BASE_URL]: "   ", [GATEWAY_ENV_API_KEY]: "" }),
    ).toBeNull();
  });
});

describe("gatewayBaseUrlsMatch", () => {
  test("matches across harness URL forms", () => {
    expect(gatewayBaseUrlsMatch("http://host:8317", "http://host:8317/v1")).toBe(true);
    expect(gatewayBaseUrlsMatch("http://host:8317/", "http://host:8317/v1/")).toBe(true);
    expect(gatewayBaseUrlsMatch("HTTP://HOST:8317", "http://host:8317/v1")).toBe(true);
  });

  test("rejects different hosts and empty values", () => {
    expect(gatewayBaseUrlsMatch("http://a:8317", "http://b:8317")).toBe(false);
    expect(gatewayBaseUrlsMatch(undefined, "http://host:8317")).toBe(false);
    expect(gatewayBaseUrlsMatch("http://host:8317", null)).toBe(false);
    expect(gatewayBaseUrlsMatch("", "")).toBe(false);
  });
});

describe("provider opt-outs", () => {
  test("claude opts out on own routing or account", () => {
    expect(claudeOverrideOptsOutOfGateway(undefined)).toBe(false);
    expect(claudeOverrideOptsOutOfGateway({})).toBe(false);
    expect(claudeOverrideOptsOutOfGateway({ ANTHROPIC_BASE_URL: "https://api.z.ai" })).toBe(true);
    expect(claudeOverrideOptsOutOfGateway({ ANTHROPIC_API_KEY: "sk-ant-x" })).toBe(true);
    expect(claudeOverrideOptsOutOfGateway({ ANTHROPIC_AUTH_TOKEN: "sk-sp-x" })).toBe(true);
    expect(claudeOverrideOptsOutOfGateway({ ANTHROPIC_BASE_URL: "  " })).toBe(false);
    expect(claudeOverrideOptsOutOfGateway({ OTHER_KEY: "value" })).toBe(false);
  });

  test("codex opts out on own endpoint", () => {
    expect(codexOverrideOptsOutOfGateway(undefined)).toBe(false);
    expect(codexOverrideOptsOutOfGateway({ OPENAI_BASE_URL: "https://relay.example.com" })).toBe(
      true,
    );
    expect(codexOverrideOptsOutOfGateway({ OPENAI_API_KEY: "sk-x" })).toBe(false);
  });

  test("omp opts out on own litellm routing or credentials", () => {
    expect(ompOverrideOptsOutOfGateway(undefined)).toBe(false);
    expect(ompOverrideOptsOutOfGateway({})).toBe(false);
    expect(
      ompOverrideOptsOutOfGateway({ LITELLM_BASE_URL: "https://litellm.example.com/v1" }),
    ).toBe(true);
    expect(ompOverrideOptsOutOfGateway({ LITELLM_API_KEY: "sk-x" })).toBe(true);
    expect(ompOverrideOptsOutOfGateway({ LITELLM_BASE_URL: "  " })).toBe(false);
    expect(ompOverrideOptsOutOfGateway({ OTHER_KEY: "value" })).toBe(false);
  });
});

describe("gateway env layers", () => {
  const gateway = { baseUrl: "http://gateway:8317", apiKey: "sk-test" };

  test("claude layer uses the bare base URL", () => {
    expect(claudeGatewayEnv(gateway)).toEqual({
      ANTHROPIC_BASE_URL: "http://gateway:8317",
      ANTHROPIC_AUTH_TOKEN: "sk-test",
    });
  });

  test("codex layer appends /v1", () => {
    expect(codexGatewayEnv(gateway)).toEqual({
      OPENAI_BASE_URL: "http://gateway:8317/v1",
      OPENAI_API_KEY: "sk-test",
    });
    expect(
      codexGatewayEnv({ baseUrl: "http://gateway:8317/v1", apiKey: "sk-test" }).OPENAI_BASE_URL,
    ).toBe("http://gateway:8317/v1");
  });

  test("omp layer sets the litellm endpoint", () => {
    expect(ompGatewayEnv(gateway)).toEqual({
      LITELLM_BASE_URL: "http://gateway:8317/v1",
      LITELLM_API_KEY: "sk-test",
    });
    expect(
      ompGatewayEnv({ baseUrl: "http://gateway:8317/v1", apiKey: "sk-test" }).LITELLM_BASE_URL,
    ).toBe("http://gateway:8317/v1");
  });
});
