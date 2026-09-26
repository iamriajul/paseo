import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { DaemonConfigStore } from "../daemon-config-store.js";
import { ClaudeAgentClient } from "./providers/claude/agent.js";
import { ProviderSnapshotManager } from "./provider-snapshot-manager.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps a discovered CLIProxyAPI model without writing additionalModels", async () => {
  const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-cliproxy-snapshot-"));
  tempDirs.push(paseoHome);
  const store = new DaemonConfigStore(paseoHome, {
    relay: { enabled: true },
    mcp: { injectIntoAgents: true },
    browserTools: { enabled: false },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
  });

  vi.stubEnv("ANTHROPIC_BASE_URL", "http://cpa.example");
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "test-token");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "claude-fable-5-dd-5.4-korg",
                display_name: "Grok 4.5",
                owned_by: "xai",
                max_input_tokens: 500_000,
                max_tokens: 65_536,
              },
            ],
            has_more: false,
          }),
          { status: 200, headers: { "x-cpa-version": "1" } },
        ),
    ),
  );

  const claudeClient = new ClaudeAgentClient({
    logger: createTestLogger(),
    configDir: paseoHome,
    resolveVersion: async () => "2.1.219",
  });
  vi.spyOn(claudeClient, "isAvailable").mockResolvedValue(true);

  const manager = new ProviderSnapshotManager({
    logger: createTestLogger(),
    extraClients: { claude: claudeClient },
  });

  try {
    const entry = await manager.getProvider({
      cwd: path.join(paseoHome, "workspace"),
      provider: "claude",
      wait: true,
    });

    expect(entry.status).toBe("ready");
    expect(entry.models).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "grok-4.5", label: "Grok 4.5" })]),
    );
    expect(store.get().providers.claude?.additionalModels).toBeUndefined();
  } finally {
    manager.destroy();
  }
});
