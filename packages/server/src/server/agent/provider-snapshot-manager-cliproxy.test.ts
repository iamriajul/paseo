import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { DaemonConfigStore, type MutableDaemonConfig } from "../daemon-config-store.js";
import { mergeAdditionalModelLimits } from "./providers/claude/cliproxy-models.js";
import { ClaudeAgentClient } from "./providers/claude/agent.js";
import { ProviderSnapshotManager } from "./provider-snapshot-manager.js";

type MutableAdditionalModel = NonNullable<
  MutableDaemonConfig["providers"][string]["additionalModels"]
>[number];

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retains a discovered CLIProxyAPI model when auto-persist changes daemon config", async () => {
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
          {
            status: 200,
            headers: { "content-type": "application/json", "x-cpa-version": "test" },
          },
        ),
    ),
  );

  const persistClaudeAdditionalModelLimits = async (
    models: Array<{
      id: string;
      label?: string;
      contextWindowMaxTokens?: number;
      maxOutputTokens?: number;
    }>,
  ) => {
    const current = store.get();
    const existing = current.providers.claude?.additionalModels ?? [];
    const merged = mergeAdditionalModelLimits(existing, models);
    if (merged === existing) return;

    store.patch(
      {
        providers: {
          claude: {
            additionalModels: merged.map(
              (model) =>
                Object.assign({}, model, {
                  label: model.label ?? model.id,
                }) as MutableAdditionalModel,
            ),
          },
        },
      },
      { preserveInFlightProviderLoads: ["claude"] },
    );
  };

  const claudeClient = new ClaudeAgentClient({
    logger: createTestLogger(),
    configDir: paseoHome,
    resolveVersion: async () => "2.1.219",
    persistClaudeAdditionalModelLimits,
  });
  vi.spyOn(claudeClient, "isAvailable").mockResolvedValue(true);

  const manager = new ProviderSnapshotManager({
    logger: createTestLogger(),
    extraClients: { claude: claudeClient },
    persistClaudeAdditionalModelLimits,
  });
  const unsubscribe = store.onChange((config, details) => {
    manager.applyMutableProviderConfig(config.providers, {
      removeProviders: details.removedProviders,
      preserveInFlightProviderLoads: details.preserveInFlightProviderLoads,
    });
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
    expect(store.get().providers.claude?.additionalModels).toEqual([
      {
        id: "grok-4.5",
        label: "grok-4.5",
        contextWindowMaxTokens: 500_000,
        maxOutputTokens: 65_536,
      },
    ]);
  } finally {
    unsubscribe();
    manager.destroy();
  }
});
