import { describe, expect, it } from "vitest";
import {
  deviceKindForViewport,
  responsiveSizeChanged,
  selectedDeviceChoice,
  viewportForDeviceChoice,
} from "./device-size";

describe("server browser device sizes", () => {
  it("sets the Browser panes' preset sizes, emulating a mobile device for phones and tablets", () => {
    expect(viewportForDeviceChoice("iphone-14", null)).toEqual({
      width: 390,
      height: 844,
      mobile: true,
    });
    expect(viewportForDeviceChoice("ipad-air", null)).toEqual({
      width: 820,
      height: 1180,
      mobile: true,
    });
    expect(viewportForDeviceChoice("desktop-1080", null)).toEqual({
      width: 1920,
      height: 1080,
      mobile: false,
    });
    expect(viewportForDeviceChoice("default", null)).toEqual({
      width: 1280,
      height: 800,
      mobile: false,
    });
  });

  it("fills the viewer for Responsive, within the daemon's bounds, once it has a size", () => {
    expect(viewportForDeviceChoice("responsive", null)).toBeNull();
    expect(viewportForDeviceChoice("responsive", { width: 913.6, height: 611.2 })).toEqual({
      width: 914,
      height: 611,
      mobile: false,
    });
    expect(viewportForDeviceChoice("responsive", { width: 120, height: 9000 })).toEqual({
      width: 200,
      height: 4000,
      mobile: false,
    });
  });

  it("ticks the choice the tab's size matches, and Responsive only while following the pane", () => {
    expect(selectedDeviceChoice({ width: 1280, height: 800, mobile: false }, false)).toBe(
      "default",
    );
    expect(selectedDeviceChoice({ width: 412, height: 915, mobile: true }, false)).toBe("pixel-7");
    expect(selectedDeviceChoice({ width: 900, height: 600, mobile: false }, false)).toBeNull();
    expect(selectedDeviceChoice({ width: 900, height: 600, mobile: false }, true)).toBe(
      "responsive",
    );
  });

  it("shows a phone for a mobile size no preset has, and a monitor otherwise", () => {
    expect(deviceKindForViewport({ width: 500, height: 900, mobile: true }, null)).toBe("phone");
    expect(deviceKindForViewport({ width: 1280, height: 800, mobile: false }, "default")).toBe(
      "desktop",
    );
    expect(deviceKindForViewport({ width: 834, height: 1194, mobile: true }, "ipad-pro-11")).toBe(
      "tablet",
    );
  });

  it("ignores a Responsive resize of a few pixels", () => {
    const current = { width: 900, height: 600 };
    expect(responsiveSizeChanged(current, { width: 903, height: 598, mobile: false })).toBe(false);
    expect(responsiveSizeChanged(current, { width: 960, height: 600, mobile: false })).toBe(true);
  });
});
