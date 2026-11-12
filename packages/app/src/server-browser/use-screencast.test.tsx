// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import type {
  DaemonClient,
  ServerBrowserVideoChunk,
} from "@getpaseo/client/internal/daemon-client";
import { describe, expect, it, vi } from "vitest";
import { useServerBrowserScreencast } from "./use-screencast";

vi.mock("@/components/retained-panel", () => ({ useRetainedPanelActive: () => true }));

function fakeClient() {
  const streams: Array<{ onChunk: (chunk: ServerBrowserVideoChunk) => void; released: boolean }> =
    [];
  const client = {
    observeServerBrowserScreencast: (
      _params: unknown,
      _onFrame: unknown,
      options?: { video: { onChunk: (chunk: ServerBrowserVideoChunk) => void } },
    ) => {
      const stream = { onChunk: options?.video.onChunk ?? (() => {}), released: false };
      streams.push(stream);
      return {
        release: async () => {
          stream.released = true;
        },
      };
    },
  } as unknown as DaemonClient;
  return { client, streams };
}

function chunk(): ServerBrowserVideoChunk & { acked: boolean } {
  const made = {
    key: true,
    width: 1,
    height: 1,
    data: new Uint8Array([0, 0, 0, 1, 0x65]),
    acked: false,
    ack: () => {
      made.acked = true;
    },
    requestKeyframe: () => {},
  };
  return made;
}

describe("useServerBrowserScreencast video", () => {
  it("stops video when the stream ends, and acks a chunk that arrives after without passing it on", () => {
    const { client, streams } = fakeClient();
    const onChunk = vi.fn();
    const onStop = vi.fn();
    const { unmount } = renderHook(() =>
      useServerBrowserScreencast({
        client,
        browserId: "tab",
        viewport: { maxWidth: 800, maxHeight: 600 },
        onFrame: () => {},
        video: { codecs: ["avc1.42E028"], onChunk, onStop },
      }),
    );
    const stream = streams[0];
    if (!stream) throw new Error("no stream");
    stream.onChunk(chunk());
    expect(onChunk).toHaveBeenCalledTimes(1);

    unmount();
    expect(onStop).toHaveBeenCalledTimes(1);
    const late = chunk();
    stream.onChunk(late);
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(late.acked).toBe(true);
  });

  it("stops video when the surface turns it off, before JPEG takes over", () => {
    const { client, streams } = fakeClient();
    const onStop = vi.fn();
    const { rerender } = renderHook(
      ({ video }: { video: boolean }) =>
        useServerBrowserScreencast({
          client,
          browserId: "tab",
          viewport: { maxWidth: 800, maxHeight: 600 },
          onFrame: () => {},
          video: video ? { codecs: ["avc1.42E028"], onChunk: () => {}, onStop } : null,
        }),
      { initialProps: { video: true } },
    );
    rerender({ video: false });
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(streams.map((stream) => stream.released)).toEqual([true, false]);
  });
});
