import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveServerBrowserEngine } from "./bootstrap.js";
import { resolveChromeExecutable } from "./chromium-executable.js";
import {
  adoptLegacyChromeProfile,
  managedChromeProfileDir,
  prepareChromeProfile,
  reducedUserAgent,
  SERVER_BROWSER_ENGINE_TRAITS,
} from "./engines.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveServerBrowserEngine", () => {
  it("keeps a switch turned on before engines existed on Headless (light), with its Chromium", () => {
    expect(resolveServerBrowserEngine({ enabled: true, executablePath: "/opt/chrome" })).toEqual({
      kind: "headless",
      executablePath: "/opt/chrome",
    });
  });

  it("falls back to Headless (light) for an engine this daemon does not know", () => {
    expect(resolveServerBrowserEngine({ enabled: true, engine: "moli" }).kind).toBe("headless");
  });

  it("reads the Existing browser URL only for that engine", () => {
    expect(
      resolveServerBrowserEngine({ engine: "existing", cdpUrl: "http://127.0.0.1:9333" }),
    ).toEqual({ kind: "existing", cdpUrl: "http://127.0.0.1:9333" });
    expect(resolveServerBrowserEngine({ engine: "managed-chrome", cdpUrl: "x" })).toEqual({
      kind: "managed-chrome",
      chromeMode: "window",
    });
  });

  it("runs Managed Chrome in a window unless headless is asked for", () => {
    expect(
      resolveServerBrowserEngine({ engine: "managed-chrome", chromeMode: "headless" }).chromeMode,
    ).toBe("headless");
    expect(
      resolveServerBrowserEngine({ engine: "managed-chrome", chromeMode: "other" }).chromeMode,
    ).toBe("window");
  });

  it("never lets the daemon close a browser it attached to", () => {
    expect(SERVER_BROWSER_ENGINE_TRAITS.existing.owned).toBe(false);
    expect(SERVER_BROWSER_ENGINE_TRAITS.headless.isolation).toBe("context");
  });
});

describe("prepareChromeProfile", () => {
  it("answers first run and metrics, keeps the profile's own settings, and clears locks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chrome-profile-"));
    dirs.push(dir);
    mkdirSync(join(dir, "Default"));
    writeFileSync(
      join(dir, "Default", "Preferences"),
      JSON.stringify({ profile: { name: "Mine", exit_type: "Crashed" }, homepage: "x" }),
    );
    writeFileSync(join(dir, "SingletonLock"), "");

    await prepareChromeProfile(dir);

    const preferences = JSON.parse(readFileSync(join(dir, "Default", "Preferences"), "utf8"));
    expect(preferences.profile).toEqual({
      name: "Mine",
      exit_type: "Normal",
      exited_cleanly: true,
    });
    expect(preferences.homepage).toBe("x");
    expect(preferences.browser.has_seen_welcome_page).toBe(true);
    const localState = JSON.parse(readFileSync(join(dir, "Local State"), "utf8"));
    expect(localState.metrics_reporting.enabled).toBe(false);
    expect(localState.distribution.skip_first_run_ui).toBe(true);
    expect(existsSync(join(dir, "First Run"))).toBe(true);
    expect(existsSync(join(dir, "SingletonLock"))).toBe(false);
  });
});

describe("resolveChromeExecutable", () => {
  it("prefers google-chrome on PATH over Chromium", async () => {
    const found = await resolveChromeExecutable({
      env: { PATH: "/a:/b" },
      platform: "linux",
      isExecutable: async (path) => path === "/b/google-chrome" || path === "/a/chromium",
    });
    expect(found).toEqual({ ok: true, path: "/b/google-chrome", source: "system" });
  });

  it("says what to install when no Chrome is found", async () => {
    const found = await resolveChromeExecutable({
      env: { PATH: "/a" },
      platform: "linux",
      isExecutable: async () => false,
    });
    expect(found.ok).toBe(false);
  });
});

describe("Managed Chrome profiles", () => {
  it("keeps Window and Headless apart", () => {
    expect(managedChromeProfileDir("/h", "window")).not.toBe(
      managedChromeProfileDir("/h", "headless"),
    );
  });

  it("hands the one profile of earlier builds to Window, and never over an existing one", async () => {
    const home = mkdtempSync(join(tmpdir(), "chrome-legacy-"));
    dirs.push(home);
    const legacy = join(home, "server-browser", "chrome-profile");
    mkdirSync(join(legacy, "Default"), { recursive: true });
    writeFileSync(join(legacy, "Default", "Cookies"), "signed in");
    const windowDir = managedChromeProfileDir(home, "window");

    await adoptLegacyChromeProfile(home, windowDir);

    expect(readFileSync(join(windowDir, "Default", "Cookies"), "utf8")).toBe("signed in");
    expect(existsSync(legacy)).toBe(false);
    mkdirSync(legacy);
    await adoptLegacyChromeProfile(home, windowDir);
    expect(existsSync(legacy)).toBe(true);
  });
});

describe("reducedUserAgent", () => {
  it("is Chrome's reduced UA for the major version and OS, with no Headless token", () => {
    expect(reducedUserAgent("153", "linux")).toBe(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    );
  });
});
