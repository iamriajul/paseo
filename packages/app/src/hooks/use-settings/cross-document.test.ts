import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { syncAppSettingsAcrossDocuments } from "./cross-document";
import { APP_SETTINGS_KEY } from "./keys";
import { APP_SETTINGS_QUERY_KEY } from "./storage";

function event(type: string, fields: Record<string, unknown>): Event {
  return Object.assign(new Event(type), fields);
}

describe("syncAppSettingsAcrossDocuments", () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  async function setup() {
    let stored = "steer";
    const queryClient = new QueryClient();
    await queryClient.fetchQuery({
      queryKey: APP_SETTINGS_QUERY_KEY,
      queryFn: () => stored,
      staleTime: Infinity,
    });
    const target = new EventTarget();
    stop = syncAppSettingsAcrossDocuments({ target, queryClient });
    const write = (value: string) => {
      stored = value;
    };
    const read = () => queryClient.getQueryData(APP_SETTINGS_QUERY_KEY);
    // Settings never go stale on their own, so only an invalidation makes this re-read.
    const settle = () =>
      queryClient.refetchQueries({ queryKey: APP_SETTINGS_QUERY_KEY, stale: true });
    return { target, write, read, settle };
  }

  it("re-reads the settings another document wrote", async () => {
    const { target, write, read, settle } = await setup();
    write("queue");
    target.dispatchEvent(event("storage", { key: APP_SETTINGS_KEY }));
    await settle();
    expect(read()).toBe("queue");
  });

  it("re-reads the settings when Back restores a frozen page", async () => {
    const { target, write, read, settle } = await setup();
    write("queue");
    target.dispatchEvent(event("pageshow", { persisted: true }));
    await settle();
    expect(read()).toBe("queue");
  });

  it("ignores other keys and a page shown fresh", async () => {
    const { target, write, read, settle } = await setup();
    write("queue");
    target.dispatchEvent(event("storage", { key: "@paseo:other" }));
    target.dispatchEvent(event("pageshow", { persisted: false }));
    await settle();
    expect(read()).toBe("steer");
  });
});
