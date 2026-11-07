import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

interface EngineSyncModule {
  ENGINE_TARGET_DIR: string;
  expectedEngineFiles(): Array<{ name: string; content: string }>;
}

// A Windows checkout may turn either copy's line endings into CRLF; the code is what must match.
function withLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

describe("vendored browser-automation engine", () => {
  it("matches the desktop engine; run scripts/sync-server-browser-engine.mjs after changing it", async () => {
    const script = join(
      import.meta.dirname,
      "../../../../../scripts/sync-server-browser-engine.mjs",
    );
    // A file URL: a bare C:\ path is not a valid ESM specifier on Windows.
    const sync = (await import(pathToFileURL(script).href)) as EngineSyncModule;
    for (const { name, content } of sync.expectedEngineFiles()) {
      expect(withLf(readFileSync(join(sync.ENGINE_TARGET_DIR, name), "utf8")), name).toBe(
        withLf(content),
      );
    }
  });
});
