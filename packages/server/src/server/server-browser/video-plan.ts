/*
 * Adapted from ace (https://github.com/arpan404/ace), packages/browser/src/video-policy.ts and
 * packages/browser/src/capture-policy.ts at commit 939e3d1fd66bbed2373dcaf65aa873a0d2ed62b6.
 * Copyright 2026 Arpan Bhandari. Licensed under the Apache License, Version 2.0
 * (http://www.apache.org/licenses/LICENSE-2.0).
 * Changes for Paseo: a viewer's picture comes from the device-pixel box it asks the screencast
 * for; tiers run at 60, 30 and 15 fps; at most three encodes per tab; no native-view viewers;
 * recovery takes three seconds instead of one.
 */

/**
 * Which video encodes a tab runs for its viewers, and who watches which. Pure: the tab's video
 * stream feeds it the page and each viewer's box, codec and load.
 *
 * A viewer gets the pixels its screen shows the page at. Viewers share an encode when their
 * codec and load tier match and the shared picture is at most a quarter larger than their own;
 * a viewer that falls behind moves to a slower tier, which is its own encode, so it never slows
 * the others. Resolution stays; frame rate drops first.
 */

export type VideoLoad = 0 | 1 | 2;

export interface VideoPlanViewer {
  id: string;
  /** Device pixels the viewer can show. */
  maxWidth: number;
  maxHeight: number;
  codec: string;
  load: VideoLoad;
}

export interface VideoPlanSource {
  /** The page's CSS size. */
  width: number;
  height: number;
  /** Device pixels per CSS pixel: no encode is sharper than the tab itself. */
  scale: number;
}

export interface VideoEncode {
  /** Stable while the encode's settings are: a new key is a new encoder (and a keyframe). */
  key: string;
  codec: string;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
}

export interface VideoPlan {
  encodes: VideoEncode[];
  /** Each viewer's encode key. */
  viewers: Map<string, string>;
}

/** Encoders one tab runs at most; more viewers join the nearest one. */
export const MAX_ENCODES_PER_TAB = 3;
/** The longest side of any frame, as for JPEG frames. */
export const MAX_VIDEO_DIMENSION = 1600;
/** The capture's own rate: the fastest tier. */
export const CAPTURE_FPS = 60;
/** A shared picture may be this much larger (per side) than a member's own. */
const SHARE_SLACK = 1.25;
const TIER_FPS: Record<VideoLoad, number> = { 0: 60, 1: 30, 2: 15 };
/** Bits per pixel per frame: slower tiers spend a little more on each frame they send. */
const TIER_BPP: Record<VideoLoad, number> = { 0: 0.07, 1: 0.09, 2: 0.09 };
const MIN_BITRATE = 300_000;
const MAX_BITRATE = 8_000_000;

function even(value: number): number {
  return Math.max(2, 2 * Math.round(value / 2));
}

/** The picture one viewer needs: the page at the size its box shows it, in device pixels. */
export function viewerPicture(
  source: VideoPlanSource,
  box: { maxWidth: number; maxHeight: number },
): { width: number; height: number } {
  const shown = Math.min(box.maxWidth / source.width, box.maxHeight / source.height);
  const scale = Math.min(
    shown,
    source.scale,
    MAX_VIDEO_DIMENSION / Math.max(source.width, source.height),
  );
  return { width: even(source.width * scale), height: even(source.height * scale) };
}

export function encodeSettings(
  codec: string,
  picture: { width: number; height: number },
  load: VideoLoad,
): VideoEncode {
  const fps = TIER_FPS[load];
  const bitrate = Math.round(
    Math.min(
      MAX_BITRATE,
      Math.max(MIN_BITRATE, picture.width * picture.height * fps * TIER_BPP[load]),
    ),
  );
  return {
    key: `${codec}/${picture.width}x${picture.height}/${fps}`,
    codec,
    width: picture.width,
    height: picture.height,
    fps,
    bitrate,
  };
}

interface Group {
  codec: string;
  load: VideoLoad;
  width: number;
  height: number;
  members: string[];
}

export function planVideo(source: VideoPlanSource, viewers: readonly VideoPlanViewer[]): VideoPlan {
  const wanted = viewers.map((viewer) => ({
    id: viewer.id,
    codec: viewer.codec,
    load: viewer.load,
    ...viewerPicture(source, viewer),
  }));
  // Largest first, so a group's first member sets its size and later ones are no larger.
  wanted.sort((a, b) => b.width * b.height - a.width * a.height || a.id.localeCompare(b.id));
  const groups: Group[] = [];
  for (const viewer of wanted) {
    const fits = groups.find(
      (group) =>
        group.codec === viewer.codec &&
        group.load === viewer.load &&
        group.width <= viewer.width * SHARE_SLACK &&
        group.height <= viewer.height * SHARE_SLACK,
    );
    if (fits) {
      fits.members.push(viewer.id);
      continue;
    }
    if (groups.length < MAX_ENCODES_PER_TAB) {
      groups.push({ ...viewer, members: [viewer.id] });
      continue;
    }
    // Out of encoders: the nearest encode of the same codec, whatever its tier.
    const area = viewer.width * viewer.height;
    const nearest = groups
      .filter((group) => group.codec === viewer.codec)
      .sort((a, b) => Math.abs(a.width * a.height - area) - Math.abs(b.width * b.height - area))[0];
    (nearest ?? groups[0])?.members.push(viewer.id);
  }
  const plan: VideoPlan = { encodes: [], viewers: new Map() };
  for (const group of groups) {
    const encode = encodeSettings(group.codec, group, group.load);
    plan.encodes.push(encode);
    for (const member of group.members) plan.viewers.set(member, encode.key);
  }
  return plan;
}

/** A backlog this long moves a viewer to the 30 fps tier. */
const BACKLOG_MS = 500;
/** A backlog this long moves it to the 15 fps tier. */
const LASTING_MS = 3000;
/**
 * This long without a backlog undoes one step. ace uses a second; a tier change itself costs a
 * keyframe and a fresh encoder, so stepping back up that fast made viewers flap between tiers.
 */
const RECOVERY_MS = 3000;

/**
 * Turns samples of "a viewer is falling behind" into a load tier. Injected time: a short decode
 * wait changes nothing, a backlog steps down at once, and recovery waits for a calm spell.
 */
export class VideoPressure {
  private since: number | undefined;
  private clearSince: number | undefined;
  private level: VideoLoad = 0;

  public get load(): VideoLoad {
    return this.level;
  }

  public sample(pending: boolean, now: number): VideoLoad {
    if (pending) {
      this.clearSince = undefined;
      this.since ??= now;
      const held = now - this.since;
      if (held >= LASTING_MS) this.level = 2;
      else if (held >= BACKLOG_MS && this.level === 0) this.level = 1;
      return this.level;
    }
    this.since = undefined;
    this.clearSince ??= now;
    if (this.level > 0 && now - this.clearSince >= RECOVERY_MS) {
      this.level = this.level === 2 ? 1 : 0;
      this.clearSince = now;
    }
    return this.level;
  }
}
