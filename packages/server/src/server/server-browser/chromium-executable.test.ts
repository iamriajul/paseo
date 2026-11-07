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
      platform: "linux",
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
      platform: "linux",
      env: { PATH: "/usr/bin" },
      home: HOME,
      ...fileSystem(["/opt/chromium/chrome", "/usr/bin/chromium"], {}),
    });
    expect(result).toEqual({ ok: true, path: "/opt/chromium/chrome", source: "config" });
  });

  it("reports a configured path that does not exist instead of silently using another", async () => {
    const result = await resolveChromiumExecutable({
      configuredPath: "/missing/chrome",
      platform: "linux",
      env: { PATH: "/usr/bin" },
      home: HOME,
      ...fileSystem(["/usr/bin/chromium"], {}),
    });
    expect(result.ok).toBe(false);
  });

  it("falls back to a system Chromium on PATH", async () => {
    const result = await resolveChromiumExecutable({
      platform: "linux",
      env: { PATH: "/usr/local/bin:/usr/bin" },
      home: HOME,
      ...fileSystem(["/usr/bin/chromium"], {}),
    });
    expect(result).toEqual({ ok: true, path: "/usr/bin/chromium", source: "system" });
  });

  it("names the install command when nothing is installed", async () => {
    const result = await resolveChromiumExecutable({
      platform: "linux",
      env: { PATH: "/usr/bin" },
      home: HOME,
      ...fileSystem([], {}),
    });
    expect(result.ok === false && result.message).toContain(SERVER_BROWSER_INSTALL_COMMAND);
  });

  it("finds Playwright's Windows headless shell under LOCALAPPDATA", async () => {
    const cache = "C:\\Users\\dev\\AppData\\Local\\ms-playwright";
    const shell = `${cache}\\chromium_headless_shell-1208\\chrome-headless-shell-win64\\chrome-headless-shell.exe`;
    const result = await resolveChromiumExecutable({
      platform: "win32",
      env: { PATH: "", LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" },
      home: "C:\\Users\\dev",
      ...fileSystem([shell], { [cache]: ["chromium_headless_shell-1208"] }),
    });
    expect(result).toEqual({ ok: true, path: shell, source: "playwright" });
  });

  it("falls back to chrome.exe on a Windows PATH, split on semicolons", async () => {
    const result = await resolveChromiumExecutable({
      platform: "win32",
      env: { Path: "C:\\Windows;C:\\Program Files\\Google\\Chrome\\Application" },
      home: "C:\\Users\\dev",
      ...fileSystem(["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"], {}),
    });
    expect(result).toEqual({
      ok: true,
      path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      source: "system",
    });
  });

  it("looks in the macOS Playwright cache", async () => {
    const cache = "/Users/dev/Library/Caches/ms-playwright";
    const shell = `${cache}/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
    const result = await resolveChromiumExecutable({
      platform: "darwin",
      env: { PATH: "" },
      home: "/Users/dev",
      ...fileSystem([shell], { [cache]: ["chromium_headless_shell-1208"] }),
    });
    expect(result).toEqual({ ok: true, path: shell, source: "playwright" });
  });

  it("searches playwright-core's own browsers under the PLAYWRIGHT_BROWSERS_PATH=0 sentinel", async () => {
    const local = "/srv/app/node_modules/playwright-core/.local-browsers";
    const shell = `${local}/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell`;
    const result = await resolveChromiumExecutable({
      platform: "linux",
      env: { PATH: "", PLAYWRIGHT_BROWSERS_PATH: "0" },
      home: HOME,
      hermeticBrowsersDir: () => local,
      ...fileSystem([shell], { [local]: ["chromium_headless_shell-1208"] }),
    });
    expect(result).toEqual({ ok: true, path: shell, source: "playwright" });
  });

  it("under the sentinel, tells the user to unset it rather than reinstall into node_modules", async () => {
    const cacheShell = `${CACHE}/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell`;
    const result = await resolveChromiumExecutable({
      platform: "linux",
      env: { PATH: "", PLAYWRIGHT_BROWSERS_PATH: "0" },
      home: HOME,
      hermeticBrowsersDir: () => null,
      // The shared cache is not where a hermetic install looks, so it is not searched either.
      ...fileSystem([cacheShell], { [CACHE]: ["chromium_headless_shell-1208"] }),
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("Unset PLAYWRIGHT_BROWSERS_PATH");
    expect(result.ok === false && result.message).toContain("serverBrowser.executablePath");
  });

  it("finds the legacy headless shell layouts Playwright 1.49-1.56 left on macOS and Windows", async () => {
    const macCache = "/Users/dev/Library/Caches/ms-playwright";
    const macShell = `${macCache}/chromium_headless_shell-1155/chrome-mac/headless_shell`;
    const mac = await resolveChromiumExecutable({
      platform: "darwin",
      env: { PATH: "" },
      home: "/Users/dev",
      ...fileSystem([macShell], { [macCache]: ["chromium_headless_shell-1155"] }),
    });
    expect(mac).toEqual({ ok: true, path: macShell, source: "playwright" });

    const winCache = "C:\\Users\\dev\\AppData\\Local\\ms-playwright";
    const winShell = `${winCache}\\chromium_headless_shell-1155\\chrome-win\\headless_shell.exe`;
    const win = await resolveChromiumExecutable({
      platform: "win32",
      env: { PATH: "", LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" },
      home: "C:\\Users\\dev",
      ...fileSystem([winShell], { [winCache]: ["chromium_headless_shell-1155"] }),
    });
    expect(win).toEqual({ ok: true, path: winShell, source: "playwright" });
  });
});
