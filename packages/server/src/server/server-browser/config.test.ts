import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadConfig } from "../config.js";
import { DaemonConfigStore } from "../daemon-config-store.js";
import { loadPersistedConfig } from "../persisted-config.js";

const homes: string[] = [];

function createStore(): { store: DaemonConfigStore; paseoHome: string } {
  const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-server-browser-config-"));
  homes.push(paseoHome);
  const store = new DaemonConfigStore(paseoHome, {
    relay: { enabled: false },
    mcp: { injectIntoAgents: false },
    browserTools: { enabled: false },
    serverBrowser: { enabled: false },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
  });
  return { store, paseoHome };
}

describe("serverBrowser config", () => {
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  test("the Settings switch persists and survives a daemon restart", async () => {
    const { store, paseoHome } = createStore();

    const live = await store.patch({
      serverBrowser: { enabled: true },
      browserTools: { enabled: true },
    });

    expect(live.serverBrowser?.enabled).toBe(true);
    expect(loadPersistedConfig(paseoHome).daemon?.serverBrowser).toEqual({ enabled: true });
    expect(loadConfig(paseoHome, { env: {} }).serverBrowser).toEqual({ enabled: true });
  });

  test("turning it off keeps a configured Chromium path", async () => {
    const { store, paseoHome } = createStore();
    await store.patch({ serverBrowser: { enabled: true, executablePath: "/opt/chromium/chrome" } });

    await store.patch({ serverBrowser: { enabled: false } });

    expect(loadPersistedConfig(paseoHome).daemon?.serverBrowser).toEqual({
      enabled: false,
      executablePath: "/opt/chromium/chrome",
    });
  });

  test("the engine and the Existing browser URL persist beside the switch", async () => {
    const { store, paseoHome } = createStore();
    await store.patch({ serverBrowser: { enabled: true, engine: "existing" } });
    // What the Settings row sends when the URL is saved.
    await store.patch({ serverBrowser: { enabled: true, cdpUrl: "http://127.0.0.1:9333" } });

    expect(loadPersistedConfig(paseoHome).daemon?.serverBrowser).toEqual({
      enabled: true,
      engine: "existing",
      cdpUrl: "http://127.0.0.1:9333",
    });
  });
});
