import { describe, expect, it } from "vitest";
import {
  createManagedChromeModePatch,
  createServerBrowserModePatch,
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
