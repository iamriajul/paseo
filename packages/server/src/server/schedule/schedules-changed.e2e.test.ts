import { expect, onTestFinished, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

test("schedule changes reach clients only through a schedules.changed subscription", async () => {
  const daemon = await createTestPaseoDaemon();
  onTestFinished(() => daemon.close());
  const writer = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const subscribed = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const unsubscribed = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  onTestFinished(async () => {
    await Promise.all([writer.close(), subscribed.close(), unsubscribed.close()]);
  });
  await Promise.all([writer.connect(), subscribed.connect(), unsubscribed.connect()]);

  expect(subscribed.getLastServerInfoMessage()?.features?.scheduleChangedEvents).toBe(true);
  await subscribed.observeEvents(["schedules.changed"]).ready;

  const seenBySubscribed: string[] = [];
  const seenByUnsubscribed: string[] = [];
  subscribed.on("schedules.changed", (message) => {
    if (message.type === "schedules.changed") seenBySubscribed.push(message.payload.scheduleId);
  });
  unsubscribed.on("schedules.changed", (message) => {
    if (message.type === "schedules.changed") seenByUnsubscribed.push(message.payload.scheduleId);
  });

  const created = await writer.scheduleCreate({
    prompt: "nightly triage",
    cadence: { type: "cron", expression: "0 3 * * *" },
    target: { type: "new-agent", config: { provider: "claude", cwd: daemon.paseoHome } },
  });
  const scheduleId = created.schedule?.id;
  expect(scheduleId).toBeTruthy();
  await writer.schedulePause({ id: scheduleId! });

  await expect.poll(() => seenBySubscribed).toEqual([scheduleId, scheduleId]);
  expect(seenByUnsubscribed).toEqual([]);
}, 60_000);
