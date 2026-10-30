// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamItem } from "@/types/stream";
import { useStreamHistoryWindow } from "./use-stream-history-window";

function message(id: string, kind: "user_message" | "assistant_message"): StreamItem {
  return { id, kind, text: id, timestamp: new Date() };
}

// The stream list reveals history from its own effect, which runs before this hook's effects
// in the same commit. Declaring the effect first reproduces that order.
function useHistoryWindowRevealingOn(input: { items: StreamItem[]; revealOn: StreamItem[] }) {
  const revealRef = useRef<() => boolean>(noReveal);
  const { items, revealOn } = input;
  useEffect(() => {
    if (items === revealOn) revealRef.current();
  }, [items, revealOn]);
  const window = useStreamHistoryWindow({ agentId: "agent-1", items, loadRemoteOlder: vi.fn() });
  revealRef.current = window.revealLoadedHistory;
  return window;
}

function noReveal(): boolean {
  return false;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS");
});

describe("useStreamHistoryWindow", () => {
  it("mounts only the most recent 20 items by default", () => {
    const items = Array.from({ length: 11 }, (_, turn) => [
      message(`u${turn}`, "user_message"),
      message(`a${turn}`, "assistant_message"),
    ]).flat();

    const { result } = renderHook(() =>
      useStreamHistoryWindow({ agentId: "agent-1", items, loadRemoteOlder: vi.fn() }),
    );

    expect(result.current.start).toBe(2);
  });

  it("reveals loaded history before requesting an older daemon page", async () => {
    Object.defineProperty(globalThis, "__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS", {
      value: 2,
      configurable: true,
    });
    const loadRemoteOlder = vi.fn(async () => true);
    const { result } = renderHook(() =>
      useStreamHistoryWindow({
        agentId: "agent-1",
        items: [
          message("u1", "user_message"),
          message("a1", "assistant_message"),
          message("u2", "user_message"),
          message("a2", "assistant_message"),
        ],
        loadRemoteOlder,
      }),
    );

    expect(result.current.start).toBe(2);
    await act(async () => result.current.loadOlder());
    expect(result.current.start).toBe(0);
    expect(loadRemoteOlder).not.toHaveBeenCalled();

    await act(async () => result.current.loadOlder());
    expect(loadRemoteOlder).toHaveBeenCalledOnce();
  });

  it("keeps its boundary at the same item when loaded history is prepended", () => {
    Object.defineProperty(globalThis, "__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS", {
      value: 2,
      configurable: true,
    });
    const items = [
      message("u1", "user_message"),
      message("a1", "assistant_message"),
      message("u2", "user_message"),
      message("a2", "assistant_message"),
    ];
    const { result, rerender } = renderHook(
      ({ history }) =>
        useStreamHistoryWindow({ agentId: "agent-1", items: history, loadRemoteOlder: vi.fn() }),
      { initialProps: { history: items } },
    );

    expect(result.current.start).toBe(2);
    rerender({
      history: [message("u0", "user_message"), message("a0", "assistant_message"), ...items],
    });
    expect(result.current.start).toBe(4);
  });

  it("keeps live appends inside the rendered window", () => {
    Object.defineProperty(globalThis, "__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS", {
      value: 2,
      configurable: true,
    });
    const items = [
      message("u1", "user_message"),
      message("a1", "assistant_message"),
      message("u2", "user_message"),
      message("a2", "assistant_message"),
    ];
    const { result, rerender } = renderHook(
      ({ history }) =>
        useStreamHistoryWindow({ agentId: "agent-1", items: history, loadRemoteOlder: vi.fn() }),
      { initialProps: { history: items } },
    );

    rerender({
      history: [...items, message("u3", "user_message"), message("a3", "assistant_message")],
    });
    expect(result.current.start).toBe(2);
  });

  it("restarts at a recent window when an item replacement removes the boundary", () => {
    Object.defineProperty(globalThis, "__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS", {
      value: 2,
      configurable: true,
    });
    const { result, rerender } = renderHook(
      ({ history }) =>
        useStreamHistoryWindow({ agentId: "agent-1", items: history, loadRemoteOlder: vi.fn() }),
      {
        initialProps: {
          history: [
            message("u1", "user_message"),
            message("a1", "assistant_message"),
            message("u2", "user_message"),
            message("a2", "assistant_message"),
          ],
        },
      },
    );

    rerender({
      history: [
        message("new-u1", "user_message"),
        message("new-a1", "assistant_message"),
        message("new-u2", "user_message"),
        message("new-a2", "assistant_message"),
        message("new-u3", "user_message"),
        message("new-a3", "assistant_message"),
      ],
    });
    expect(result.current.start).toBe(4);
  });

  it("keeps a reveal made in the same commit that replaced the boundary item", () => {
    Object.defineProperty(globalThis, "__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS", {
      value: 2,
      configurable: true,
    });
    const cached = [
      message("u1", "user_message"),
      message("a1", "assistant_message"),
      message("u2", "user_message"),
      message("a2", "assistant_message"),
    ];
    const fresh = [
      message("new-u1", "user_message"),
      message("new-a1", "assistant_message"),
      message("new-u2", "user_message"),
      message("new-a2", "assistant_message"),
      message("new-u3", "user_message"),
      message("new-a3", "assistant_message"),
    ];
    const { result, rerender } = renderHook(
      ({ history }) => useHistoryWindowRevealingOn({ items: history, revealOn: fresh }),
      { initialProps: { history: cached } },
    );
    act(() => {
      result.current.revealLoadedHistory();
    });
    expect(result.current.start).toBe(0);

    rerender({ history: fresh });

    expect(result.current.start).toBe(2);
  });

  it("does not claim to reveal a missing or already-visible item", () => {
    Object.defineProperty(globalThis, "__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS", {
      value: 2,
      configurable: true,
    });
    const { result } = renderHook(() =>
      useStreamHistoryWindow({
        agentId: "agent-1",
        items: [
          message("u1", "user_message"),
          message("a1", "assistant_message"),
          message("u2", "user_message"),
          message("a2", "assistant_message"),
        ],
        loadRemoteOlder: vi.fn(),
      }),
    );

    expect(result.current.revealLoadedHistory("missing")).toBe(false);
    expect(result.current.revealLoadedHistory("u2")).toBe(false);
  });
});
