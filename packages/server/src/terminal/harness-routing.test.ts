import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTerminalEnvironment } from "./terminal.js";
import { buildTerminalGatewayRouting } from "./harness-routing.js";
import { resolveHarnessShimDirectory } from "./harness-shim-writer.js";
import type { ResolvedGatewayConfig } from "../server/agent/gateway/config.js";

const gateway: ResolvedGatewayConfig = {
  baseUrl: "http://cpa.test:8317",
  apiKey: "sk-test",
};

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "paseo-routing-test-"));
}

/** The env a terminal would actually spawn with, minus the daemon's own env. */
function spawnEnv(input: {
  paseoHome: string;
  gateway: ResolvedGatewayConfig | null;
  env?: Record<string, string>;
}): Record<string, string> {
  const routing = buildTerminalGatewayRouting({
    paseoHome: input.paseoHome,
    gateway: input.gateway,
  });
  return buildTerminalEnvironment({
    shell: "/bin/bash",
    paseoCliBinDir: null,
    paseoHookCliPath: null,
    env: input.env ?? {},
    harnessShimDirectory: routing.shimDirectory,
    gatewayEnv: routing.env,
  });
}

describe("terminal gateway routing", () => {
  it("puts the shims ahead of the real binaries on PATH", () => {
    const home = makeHome();
    const env = spawnEnv({ paseoHome: home, gateway });
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    const entries = env[pathKey].split(delimiter);

    expect(entries[0]).toBe(resolveHarnessShimDirectory(home));
  });

  it("routes OMP through env, since it reads LITELLM_* directly", () => {
    const env = spawnEnv({ paseoHome: makeHome(), gateway });
    expect(env.LITELLM_BASE_URL).toBe("http://cpa.test:8317/v1");
    expect(env.LITELLM_API_KEY).toBe("sk-test");
  });

  it("leaves the shimmed harnesses' own env to the shim, not the shell", () => {
    const env = spawnEnv({ paseoHome: makeHome(), gateway });
    // A shim exists precisely so these do not leak into every process the
    // shell spawns; only the harness invocation should see them. They are
    // compared against the daemon's own env, which may legitimately carry
    // them already, rather than asserted absent.
    for (const key of [
      "ANTHROPIC_BASE_URL",
      "OPENAI_BASE_URL",
      "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
      "OPENCODE_CONFIG_CONTENT",
    ]) {
      expect(env[key]).toBe(process.env[key]);
    }
  });

  it("adds no PATH entry and no env without a gateway", () => {
    const env = spawnEnv({ paseoHome: makeHome(), gateway: null });
    expect(env.LITELLM_BASE_URL).toBeUndefined();
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    expect(env[pathKey]).not.toContain("harness-shims");
  });

  it("leaves a workspace's own routing env in charge", () => {
    // registerCwdEnv and per-create env land in the `env` input, which is
    // applied over the gateway layer. A workspace that already points its
    // terminals somewhere must not be silently rerouted.
    const env = spawnEnv({
      paseoHome: makeHome(),
      gateway,
      env: { LITELLM_BASE_URL: "http://workspace-owned:4000" },
    });
    expect(env.LITELLM_BASE_URL).toBe("http://workspace-owned:4000");
  });

  it("rewrites the shims on each create so a gateway edit lands without a restart", () => {
    const home = makeHome();
    const first = spawnEnv({ paseoHome: home, gateway });
    const rotated: ResolvedGatewayConfig = { baseUrl: "http://other:9000", apiKey: "sk-rotated" };
    const second = spawnEnv({ paseoHome: home, gateway: rotated });
    const third = spawnEnv({ paseoHome: home, gateway });

    // The directory is stable, so a terminal keeps its PATH entry; the shim
    // inside it is rewritten, so the next invocation reads the new gateway.
    const shimDirectory = resolveHarnessShimDirectory(home);
    const pathKey = Object.keys(third).find((key) => key.toLowerCase() === "path") ?? "PATH";
    expect(third[pathKey].split(delimiter)[0]).toBe(shimDirectory);
    expect(second.LITELLM_API_KEY).toBe("sk-rotated");
    expect(third.LITELLM_API_KEY).toBe("sk-test");
    expect(first.LITELLM_API_KEY).toBe("sk-test");
  });
});
