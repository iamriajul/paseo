import { describe, expect, it } from "vitest";
import {
  resolveChromiumExecutable,
  SERVER_BROWSER_INSTALL_COMMAND,
} from "./chromium-executable.js";

const HOME = "/home/dev";
const CACHE = "/home/dev/.cache/ms-playwright";

function fileSystem(executables: string[], directories: Record<string, string[]>) {
  return {
    isExecutable: async (path: string) => executables.includes(path),
    listDirectory: async (path: string) => directories[path] ?? [],
  };
}

describe("resolveChromiumExecutable", () => {
  it("prefers the newest Playwright headless shell over full Chromium", async () => {
    const shell1208 = `${CACHE}/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell`;
    const shell1100 = `${CACHE}/chromium_headless_shell-1100/chrome-headless-shell-linux64/chrome-headless-shell`;
    const full = `${CACHE}/chromium-1208/chrome-linux64/chrome`;
    const result = await resolveChromiumExecutable({
      env: { PATH: "" },
      home: HOME,
      ...fileSystem([shell1100, shell1208, full], {
        [CACHE]: ["chromium-1208", "chromium_headless_shell-1100", "chromium_headless_shell-1208"],
      }),
    });
    expect(result).toEqual({ ok: true, path: shell1208, source: "playwright" });
  });

  it("uses the configured path before anything it could find", async () => {
    const result = await resolveChromiumExecutable({
      configuredPath: "/opt/chromium/chrome",
      env: { PATH: "/usr/bin" },
      home: HOME,
      ...fileSystem(["/opt/chromium/chrome", "/usr/bin/chromium"], {}),
    });
    expect(result).toEqual({ ok: true, path: "/opt/chromium/chrome", source: "config" });
  });

  it("reports a configured path that does not exist instead of silently using another", async () => {
    const result = await resolveChromiumExecutable({
      configuredPath: "/missing/chrome",
      env: { PATH: "/usr/bin" },
      home: HOME,
      ...fileSystem(["/usr/bin/chromium"], {}),
    });
    expect(result.ok).toBe(false);
  });

  it("falls back to a system Chromium on PATH", async () => {
    const result = await resolveChromiumExecutable({
      env: { PATH: "/usr/local/bin:/usr/bin" },
      home: HOME,
      ...fileSystem(["/usr/bin/chromium"], {}),
    });
    expect(result).toEqual({ ok: true, path: "/usr/bin/chromium", source: "system" });
  });

  it("names the install command when nothing is installed", async () => {
    const result = await resolveChromiumExecutable({
      env: { PATH: "/usr/bin" },
      home: HOME,
      ...fileSystem([], {}),
    });
    expect(result.ok === false && result.message).toContain(SERVER_BROWSER_INSTALL_COMMAND);
  });
});
