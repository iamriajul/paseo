import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";

// Fork decision agent-messages-collapse: a folded message from another agent reads as a message,
// and folds the recipient's whole response to it, including the turns it then started on its own.

type Theme = "dark" | "light";

async function useSettings(
  page: Page,
  settings: { theme: Theme; agentMessagesDisplay?: "collapsed" | "expanded" },
): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem(
      "@paseo:app-settings",
      JSON.stringify({ chatDisplay: "collapseTurns", ...value }),
    );
  }, settings);
}

const MESSAGE =
  "A CI change from the founder: a beta release does not need the full Android build.\n" +
  "Check the workflow and report back.\n" +
  "wake 2 times after this turn";

async function sendFrom(recipient: MockAgentWorkspace, title: string, text = MESSAGE) {
  const sender = await recipient.client.createAgent({
    provider: "mock",
    cwd: recipient.cwd,
    workspaceId: recipient.workspaceId,
    title,
    modeId: "load-test",
    model: "e2e-fast-stream",
  });
  await recipient.client.sendAgentMessage(recipient.agentId, text, { sourceAgentId: sender.id });
  return sender;
}

/** The recipient answered, then woke twice on its own; the last wake's reply ends the run. */
async function waitForWakes(page: Page): Promise<void> {
  await expect(page.getByText("Background task finished; 0 left.")).toBeVisible({
    timeout: 60_000,
  });
}

async function chatShot(page: Page, path: string): Promise<void> {
  await page.getByText("Background task finished; 0 left.").scrollIntoViewIfNeeded();
  await page.screenshot({ path });
}

test("a folded agent message reads as a message and folds every wake of its turn", async ({
  page,
}, testInfo) => {
  await useSettings(page, { theme: "dark", agentMessagesDisplay: "collapsed" });
  const recipient = await seedMockAgentWorkspace({
    repoPrefix: "agent-fold-",
    title: "Release owner",
  });
  try {
    await sendFrom(recipient, "DeepCycle PA");
    await openAgentRoute(page, recipient);
    await expectComposerVisible(page);
    await waitForWakes(page);

    const line = page.getByTestId("agent-message-line");
    await expect(line).toContainText("DeepCycle PA");
    await expect(line).toContainText("A CI change from the founder");
    // The first reply and the first wake fold behind the message's summary with its work.
    await expect(page.getByText("Background task finished; 1 left.")).toHaveCount(0);
    await expect(page.getByTestId("turn-summary")).toHaveCount(1);
    await chatShot(page, testInfo.outputPath("folded-turn-dark.png"));

    await page.getByTestId("turn-summary").click();
    await expect(page.getByText("Background task finished; 1 left.")).toBeVisible();
    await chatShot(page, testInfo.outputPath("folded-turn-opened-dark.png"));
  } finally {
    await recipient.cleanup();
  }
});

test("agent messages show in full by default, with each wake of the turn", async ({
  page,
}, testInfo) => {
  await useSettings(page, { theme: "light" });
  const recipient = await seedMockAgentWorkspace({
    repoPrefix: "agent-fold-default-",
    title: "Release owner",
  });
  try {
    await sendFrom(recipient, "DeepCycle PA");
    await openAgentRoute(page, recipient);
    await expectComposerVisible(page);
    await waitForWakes(page);
    await expect(page.getByRole("button", { name: "Sent by DeepCycle PA" })).toBeVisible();
    await expect(page.getByTestId("agent-message-line")).toHaveCount(0);
    await chatShot(page, testInfo.outputPath("expanded-default-light.png"));

    // Folding the message from its bubble folds the turn through its wakes.
    await page.getByTestId("agent-message-collapse").click();
    await expect(page.getByTestId("agent-message-line")).toBeVisible();
    await expect(page.getByText("Background task finished; 1 left.")).toHaveCount(0);
    await chatShot(page, testInfo.outputPath("folded-turn-light.png"));
  } finally {
    await recipient.cleanup();
  }
});

for (const theme of ["dark", "light"] as const) {
  test(`a long sender name truncates inside the folded line on a phone (${theme})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await useSettings(page, { theme, agentMessagesDisplay: "collapsed" });
    const recipient = await seedMockAgentWorkspace({
      repoPrefix: "agent-fold-phone-",
      title: "Release owner",
    });
    try {
      await sendFrom(
        recipient,
        "Reviewer checking the compact chat timeline and sender attribution",
      );
      await openAgentRoute(page, recipient);
      await expectComposerVisible(page);
      await waitForWakes(page);
      const line = page.getByTestId("agent-message-line");
      await expect(line).toBeVisible();
      const box = (await line.boundingBox())!;
      expect(box.height).toBeLessThan(48);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      await chatShot(page, testInfo.outputPath(`phone-long-sender-${theme}.png`));
    } finally {
      await recipient.cleanup();
    }
  });
}

test("consecutive messages from one agent fold into one group row", async ({ page }, testInfo) => {
  await useSettings(page, { theme: "dark", agentMessagesDisplay: "collapsed" });
  const recipient = await seedMockAgentWorkspace({
    repoPrefix: "agent-fold-group-",
    title: "Release owner",
    model: "ten-second-stream",
  });
  try {
    const sender = await sendFrom(recipient, "DeepCycle PA", "Status check 1: is the beta green?");
    for (const index of [2, 3]) {
      await recipient.client.sendAgentMessage(
        recipient.agentId,
        `Status check ${index}: is the beta green?`,
        { sourceAgentId: sender.id },
      );
    }
    await recipient.client.waitForFinish(recipient.agentId, 60_000);
    await openAgentRoute(page, recipient);
    await expectComposerVisible(page);
    const group = page.getByTestId("agent-message-group");
    await expect(group).toContainText("DeepCycle PA");
    await expect(group).toContainText("3 messages");
    await group.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("group-closed-dark.png") });
    await group.click();
    await expect(page.getByTestId("agent-message-line")).toHaveCount(3);
    await page.screenshot({ path: testInfo.outputPath("group-open-dark.png") });
  } finally {
    await recipient.cleanup();
  }
});
