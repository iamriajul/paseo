import { expect, onTestFinished, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const COMPOSER_KEY = "agent:fork-session-events-agent";

test("ui_state pushes reach other devices only through a fork session event subscription", async () => {
  const daemon = await createTestPaseoDaemon();
  onTestFinished(() => daemon.close());
  const writer = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const subscribed = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const unsubscribed = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  onTestFinished(async () => {
    await Promise.all([writer.close(), subscribed.close(), unsubscribed.close()]);
  });
  await Promise.all([writer.connect(), subscribed.connect(), unsubscribed.connect()]);

  expect(subscribed.getLastServerInfoMessage()?.features?.forkSessionEvents).toBe(true);
  await subscribed.observeEvents(["ui_state.updated"]).ready;

  const seenBySubscribed: string[] = [];
  const seenByUnsubscribed: string[] = [];
  subscribed.on("ui_state.updated", (message) => {
    if (message.type === "ui_state.updated") seenBySubscribed.push(message.record?.text ?? "");
  });
  unsubscribed.on("ui_state.updated", (message) => {
    if (message.type === "ui_state.updated") seenByUnsubscribed.push(message.record?.text ?? "");
  });

  await writer.upsertUiState({
    namespace: "composer",
    key: COMPOSER_KEY,
    record: { text: "typed on another device", updatedAt: new Date().toISOString() },
  });

  await expect.poll(() => seenBySubscribed).toEqual(["typed on another device"]);
  expect(seenByUnsubscribed).toEqual([]);
}, 60_000);
