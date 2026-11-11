import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import { encodeSettings, planVideo, VideoPressure, viewerPicture } from "./video-plan.js";

const PAGE = { width: 1280, height: 800, scale: 1 };

describe("planVideo", () => {
  test("viewers on the same tier and about the same size share one encode", () => {
    const plan = planVideo(PAGE, [
      { id: "desk", maxWidth: 1250, maxHeight: 800, codec: "avc1.42E028", load: 0 },
      { id: "laptop", maxWidth: 1100, maxHeight: 700, codec: "avc1.42E028", load: 0 },
    ]);
    expect(plan.encodes).toHaveLength(1);
    expect(plan.viewers.get("desk")).toBe(plan.viewers.get("laptop"));
  });

  test("a viewer that falls behind gets its own slower encode; the others keep 60 fps", () => {
    const plan = planVideo(PAGE, [
      { id: "desk", maxWidth: 1280, maxHeight: 800, codec: "avc1.42E028", load: 0 },
      { id: "phone", maxWidth: 1280, maxHeight: 800, codec: "avc1.42E028", load: 2 },
    ]);
    const fpsOf = (id: string) =>
      plan.encodes.find((encode) => encode.key === plan.viewers.get(id))?.fps;
    expect(fpsOf("desk")).toBe(60);
    expect(fpsOf("phone")).toBe(15);
  });

  test("a viewer gets the pixels its box shows the page at, never more than the page has", () => {
    expect(viewerPicture(PAGE, { maxWidth: 640, maxHeight: 1000 })).toEqual({
      width: 640,
      height: 400,
    });
    expect(viewerPicture(PAGE, { maxWidth: 4000, maxHeight: 4000 })).toEqual({
      width: 1280,
      height: 800,
    });
    // A phone-size tab at 2x: 780x1688 device pixels, capped at 1600 on the long side.
    expect(
      viewerPicture({ width: 390, height: 844, scale: 2 }, { maxWidth: 3000, maxHeight: 3000 }),
    ).toEqual({
      width: 740,
      height: 1600,
    });
  });

  test("bitrate follows the picture and the tier", () => {
    expect(encodeSettings("avc1.42E028", { width: 1280, height: 800 }, 0).bitrate).toBe(4_300_800);
    expect(encodeSettings("avc1.42E028", { width: 64, height: 64 }, 2).bitrate).toBe(300_000);
  });

  test("past three encodes a viewer joins the nearest one", () => {
    const viewers = [0, 1, 2, 3].map((i) => ({
      id: `v${i}`,
      maxWidth: 1280 - i * 300,
      maxHeight: 800,
      codec: "avc1.42E028",
      load: 0 as const,
    }));
    const plan = planVideo(PAGE, viewers);
    expect(plan.encodes).toHaveLength(3);
    expect(plan.viewers.size).toBe(4);
  });
});

describe("VideoPressure", () => {
  test("a backlog steps the tier down, and three calm seconds undo one step", () => {
    const pressure = new VideoPressure();
    expect(pressure.sample(true, 0)).toBe(0);
    expect(pressure.sample(true, 500)).toBe(1);
    expect(pressure.sample(true, 3000)).toBe(2);
    expect(pressure.sample(false, 3100)).toBe(2);
    expect(pressure.sample(false, 5100)).toBe(2);
    expect(pressure.sample(false, 6100)).toBe(1);
    expect(pressure.sample(false, 9100)).toBe(0);
  });
});

interface Pacing {
  EncodePacer: new (fps: number) => {
    frame(now: number, busy: boolean): "skip" | "delta" | "key";
    still(now: number, lastFrameAt: number, busy: boolean): boolean;
    requestKeyframe(): void;
  };
}

function loadPacing(): Pacing {
  const context: { paseoPacing?: Pacing } = {};
  runInNewContext(
    readFileSync(new URL("./tab-video-extension/pacing.js", import.meta.url), "utf8"),
    context,
  );
  if (!context.paseoPacing) throw new Error("pacing.js defined nothing");
  return context.paseoPacing;
}

describe("the extension's encode pacer", () => {
  test("starts with a keyframe, paces deltas to the encode's rate, and spaces forced keyframes", () => {
    const pacer = new (loadPacing().EncodePacer)(30);
    expect(pacer.frame(0, false)).toBe("key");
    expect(pacer.frame(16, false)).toBe("skip");
    expect(pacer.frame(33, false)).toBe("delta");
    pacer.requestKeyframe();
    expect(pacer.frame(66, false)).toBe("delta");
    expect(pacer.frame(500, false)).toBe("key");
  });

  test("a still page re-encodes its last frame for an owed keyframe", () => {
    const pacer = new (loadPacing().EncodePacer)(60);
    pacer.frame(0, false);
    pacer.requestKeyframe();
    expect(pacer.still(50, 0, false)).toBe(false);
    expect(pacer.still(600, 0, false)).toBe(true);
  });
});
