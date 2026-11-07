import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface EngineSyncModule {
  ENGINE_TARGET_DIR: string;
  expectedEngineFiles(): Array<{ name: string; content: string }>;
}

describe("vendored browser-automation engine", () => {
  it("matches the desktop engine; run scripts/sync-server-browser-engine.mjs after changing it", async () => {
    const script = join(
      import.meta.dirname,
      "../../../../../scripts/sync-server-browser-engine.mjs",
    );
    const sync = (await import(script)) as EngineSyncModule;
    for (const { name, content } of sync.expectedEngineFiles()) {
      expect(readFileSync(join(sync.ENGINE_TARGET_DIR, name), "utf8"), name).toBe(content);
    }
  });
});
