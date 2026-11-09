import { describe, expect, it } from "vitest";
import {
  createManagedChromeModePatch,
  createNewTabTargetPatch,
  createServerBrowserModePatch,
  describeNewTabTarget,
  resolveNewTabTarget,
  resolveManagedChromeMode,
  resolveServerBrowserMode,
} from "./engine-mode";

describe("Managed Chrome mode", () => {
  it("is a window unless headless was picked", () => {
    expect(resolveManagedChromeMode(undefined)).toBe("window");
    expect(resolveManagedChromeMode({ chromeMode: "headless" })).toBe("headless");
  });

  it("keeps Managed Chrome on while switching mode", () => {
    expect(createManagedChromeModePatch("headless")).toEqual({
      serverBrowser: { enabled: true, engine: "managed-chrome", chromeMode: "headless" },
    });
  });
});

describe("server browser mode", () => {
  it("keeps a switch turned on before engines existed on Headless (light)", () => {
    expect(resolveServerBrowserMode({ enabled: true })).toBe("headless");
    expect(resolveServerBrowserMode({ enabled: true, engine: "some-future-engine" })).toBe(
      "headless",
    );
  });

  it("reads off whatever engine is saved while the switch is off", () => {
    expect(resolveServerBrowserMode(undefined)).toBe("off");
    expect(resolveServerBrowserMode({ enabled: false, engine: "managed-chrome" })).toBe("off");
  });

  it("reads the saved engine while on", () => {
    expect(resolveServerBrowserMode({ enabled: true, engine: "existing" })).toBe("existing");
    expect(resolveServerBrowserMode({ enabled: true, engine: "managed-chrome" })).toBe(
      "managed-chrome",
    );
  });

  it("turns browser tools on with any engine and leaves them alone when off", () => {
    expect(createServerBrowserModePatch("managed-chrome")).toEqual({
      serverBrowser: { enabled: true, engine: "managed-chrome" },
      browserTools: { enabled: true },
    });
    expect(createServerBrowserModePatch("off")).toEqual({ serverBrowser: { enabled: false } });
  });
});

describe("default for new tabs", () => {
  it("is Automatic unless Server or Desktop was picked", () => {
    expect(resolveNewTabTarget(undefined)).toBe("auto");
    expect(resolveNewTabTarget({ newTabTarget: "some-future-target" })).toBe("auto");
    expect(resolveNewTabTarget({ newTabTarget: "desktop" })).toBe("desktop");
  });

  it("leaves the server browser switch as it is while changing the default", () => {
    expect(createNewTabTargetPatch({ target: "server", serverBrowserEnabled: true })).toEqual({
      serverBrowser: { enabled: true, newTabTarget: "server" },
    });
    expect(createNewTabTargetPatch({ target: "desktop", serverBrowserEnabled: false })).toEqual({
      serverBrowser: { enabled: false, newTabTarget: "desktop" },
    });
  });

  it("says Automatic means desktop and Server is unavailable while the server browser is off", () => {
    expect(describeNewTabTarget({ target: "auto", serverBrowserEnabled: false })).toContain(
      "Automatic opens agents' new tabs in the desktop app's Browser",
    );
    expect(describeNewTabTarget({ target: "server", serverBrowserEnabled: false })).toContain(
      "Server is unavailable",
    );
    expect(describeNewTabTarget({ target: "auto", serverBrowserEnabled: true })).toContain(
      "otherwise the server browser",
    );
  });
});
