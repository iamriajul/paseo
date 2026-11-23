// Quote and side questions, in the real app against a real Claude Code that talks to a local stub
// of the Messages API: no model, gateway or account. Each flow runs at desktop width and at phone
// width. The stub records every request, so the tests read what reached the model.
import { existsSync } from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test as base } from "../support/fixtures";
import {
  type ClaudeMessagesStub,
  startClaudeMessagesStub,
} from "../support/helpers/claude-messages-stub";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { closeSheet } from "../support/helpers/sheet";
import { seedWorkspace } from "../support/helpers/seed-client";

const test = base.extend<
  object,
  { claudeStub: ClaudeMessagesStub; e2eDaemonEnvironment: Record<string, string> }
>({
  claudeStub: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright reads fixture needs from the pattern
    async ({}, provide) => {
      const stub = await startClaudeMessagesStub();
      try {
        await provide(stub);
      } finally {
        await stub.close();
      }
    },
    { scope: "worker" },
  ],
  e2eDaemonEnvironment: [
    async ({ claudeStub }, provide) => {
      await provide(claudeStub.environment);
    },
    { scope: "worker" },
  ],
});

const FIRST_PROMPT = "Raise the relay wake threshold";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

interface Chat {
  agentId: string;
  workspaceId: string;
  cwd: string;
  client: Awaited<ReturnType<typeof seedWorkspace>>["client"];
  close(): Promise<void>;
}

/** A Claude agent that has answered one prompt, in a fresh git workspace. */
async function seedChat(stub: ClaudeMessagesStub): Promise<Chat> {
  const workspace = await seedWorkspace({ repoPrefix: "quote-side-questions-" });
  try {
    const agent = await workspace.client.createAgent({
      provider: "claude",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Relay threshold",
      model: "claude-haiku-5-5",
      modeId: "bypassPermissions",
      featureValues: { prompt_cache_ttl: "1h" },
      initialPrompt: FIRST_PROMPT,
    });
    await workspace.client.waitForFinish(agent.id, 60_000);
    expect(stub.requests.length).toBeGreaterThan(0);
    return {
      agentId: agent.id,
      workspaceId: workspace.workspaceId,
      cwd: workspace.repoPath,
      client: workspace.client,
      close: workspace.cleanup,
    };
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}

function mainComposer(page: Page): Locator {
  return page.getByRole("textbox", { name: /Message agent/ }).first();
}

function sideComposer(page: Page): Locator {
  return page.getByPlaceholder("Ask about this conversation");
}

/**
 * Waits until the newest request's newest user turn says this. Counting requests is not enough:
 * Claude Code can send another request for the previous prompt, which lands first.
 */
async function waitForLastPrompt(stub: ClaudeMessagesStub, text: string): Promise<void> {
  const newest = () =>
    stub.lastUserText(stub.requests.at(-1) ?? { messages: [], system: null, headers: {} });
  await expect.poll(newest, { timeout: 60_000 }).toContain(text);
}

/** The newest user turn, among requests from index `from` on, that says this. */
function findPromptSince(stub: ClaudeMessagesStub, from: number, text: string): string | undefined {
  return stub.requests
    .slice(from)
    .map((request) => stub.lastUserText(request))
    .find((prompt) => prompt.includes(text));
}

/** Presses the Send button that belongs to this input: a phone may hold two composers at once. */
async function send(input: Locator): Promise<void> {
  await input
    .locator("xpath=ancestor::*[.//*[@aria-label='Send message']][1]")
    .getByRole("button", { name: "Send message" })
    .click();
}

async function shot(page: Page, name: string): Promise<void> {
  const directory = process.env.PASEO_QA_SCREENSHOT_DIR;
  if (!directory) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(directory, `${name}.png`) });
}

async function lastAssistantMessage(page: Page): Promise<Locator> {
  const message = page.getByTestId("assistant-message").last();
  await expect(message).toBeVisible({ timeout: 30_000 });
  return message;
}

/** Selects the text of one element, as a drag across it would. */
async function selectText(page: Page, target: Locator): Promise<void> {
  await target.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

for (const viewport of [
  { name: "desktop", size: DESKTOP },
  { name: "phone", size: PHONE },
]) {
  test.describe(`${viewport.name} width`, () => {
    test.use({ viewport: viewport.size });

    test("quote: a message goes to the composer as a card and reaches the agent as text", async ({
      page,
      claudeStub,
    }) => {
      const chat = await seedChat(claudeStub);
      try {
        await openAgentRoute(page, { workspaceId: chat.workspaceId, agentId: chat.agentId });
        await lastAssistantMessage(page);

        await test.step("the footer quotes the whole reply", async () => {
          await page.getByTestId("turn-quote-button").last().click();
          const card = page.getByTestId("composer-quote-card");
          await expect(card).toBeVisible();
          await expect(card).toContainText("The old session keys are discarded on purpose");
          await shot(page, `${viewport.name}-quote-card`);
        });

        await test.step("sending carries the quote as text ahead of the question", async () => {
          await mainComposer(page).fill("Why discard them instead of rotating?");
          await send(mainComposer(page));
          await expect(page.getByTestId("user-message-quote")).toBeVisible({ timeout: 30_000 });
          await expect(page.getByTestId("composer-quote-card")).toHaveCount(0);
          await waitForLastPrompt(claudeStub, "Why discard them instead of rotating?");
          const received = claudeStub.lastUserText(claudeStub.requests.at(-1)!);
          expect(received).toBe(
            [
              "> [Quoted from your earlier reply]",
              "> Done. The threshold is now `relay.wakeDriftMs` in the host config, default 45000, minimum 5000.",
              ">",
              "> The old session keys are discarded on purpose.",
              "",
              "Why discard them instead of rotating?",
            ].join("\n"),
          );
          await shot(page, `${viewport.name}-quote-sent`);
        });
      } finally {
        await chat.close();
      }
    });
  });
}

test.describe("desktop width", () => {
  test.use({ viewport: DESKTOP });

  test("quote: a selection offers Quote and Ask aside above it", async ({ page, claudeStub }) => {
    const chat = await seedChat(claudeStub);
    try {
      await openAgentRoute(page, { workspaceId: chat.workspaceId, agentId: chat.agentId });
      const message = await lastAssistantMessage(page);
      await selectText(page, message.getByText("The old session keys are discarded on purpose."));
      const toolbar = page.getByTestId("quote-selection-toolbar");
      await expect(toolbar).toBeVisible();
      await expect(page.getByTestId("quote-selection-ask-aside")).toBeVisible();
      await shot(page, "desktop-selection-toolbar");
      await page.getByTestId("quote-selection-quote").click();
      const card = page.getByTestId("composer-quote-card");
      await expect(card).toContainText("selection");
      await expect(card).toContainText("The old session keys are discarded on purpose");
      await expect(card).not.toContainText("relay.wakeDriftMs");
    } finally {
      await chat.close();
    }
  });
});

for (const viewport of [
  { name: "desktop", size: DESKTOP },
  { name: "phone", size: PHONE },
]) {
  test.describe(`${viewport.name} width: side questions`, () => {
    test.use({ viewport: viewport.size });

    test("a side question is read-only, leaves the main chat alone, and brings an answer back as a quote", async ({
      page,
      claudeStub,
    }) => {
      const chat = await seedChat(claudeStub);
      const wrote = path.join(chat.cwd, "side-question-wrote.txt");
      const touched = path.join(chat.cwd, "side-question-ran");
      claudeStub.script("SCRIPT-SIDE", [
        { name: "Write", input: { file_path: wrote, content: "changed" } },
        { name: "Bash", input: { command: `touch ${touched}`, description: "touch" } },
      ]);
      try {
        await openAgentRoute(page, { workspaceId: chat.workspaceId, agentId: chat.agentId });
        await lastAssistantMessage(page);

        await test.step("the composer's button opens a read-only side question", async () => {
          await page.getByTestId("composer-ask-aside").click();
          const header = page.getByTestId("side-question-header");
          await expect(header).toBeVisible({ timeout: 30_000 });
          await expect(header).toContainText("Side question");
          await expect(header).toContainText("Read-only");
          await expect(page.getByTestId("side-question-context")).toContainText(
            "up to the latest reply",
          );
          await expect(sideComposer(page)).toBeVisible();
          await expect(page.getByTestId("side-question-cost-line")).toContainText(
            /Cache warm\. Reads \d+k cached tokens\./,
          );
          await shot(page, `${viewport.name}-side-question-empty`);
        });

        await test.step("a question is answered from a copy of the conversation", async () => {
          const before = claudeStub.requests.length;
          await sideComposer(page).fill("Why 45000?");
          await send(sideComposer(page));
          // The bubble shows the user's own words: the notice is stripped from the timeline.
          const bubble = page.getByTestId("user-message").filter({ hasText: "Why 45000?" });
          await expect(bubble).toBeVisible({ timeout: 30_000 });
          await expect(bubble).not.toContainText("This is a side question");
          await expect(page.getByTestId("assistant-message").last()).toContainText(
            "This is the prompt I received",
            { timeout: 30_000 },
          );
          const asked = findPromptSince(claudeStub, before, "Why 45000?");
          expect(asked).toContain("This is a side question");
          expect(asked).toContain("Why 45000?");
          await shot(page, `${viewport.name}-side-question-answered`);
        });

        await test.step("a call that would change the disk is blocked, and a full session is offered", async () => {
          await sideComposer(page).fill("SCRIPT-SIDE please");
          await send(sideComposer(page));
          await expect(page.getByTestId("side-question-blocked-callout")).toBeVisible({
            timeout: 60_000,
          });
          expect(existsSync(wrote)).toBe(false);
          expect(existsSync(touched)).toBe(false);
          await shot(page, `${viewport.name}-side-question-blocked`);
        });

        await test.step("Quote in main chat puts the answer in the main composer", async () => {
          await page.getByTestId("turn-quote-in-main-chat").last().click();
          const card = page.getByTestId("composer-quote-card");
          await expect(card).toBeVisible();
          await expect(card).toContainText("Side question");
          await shot(page, `${viewport.name}-side-question-quoted-in-main`);
        });

        await test.step("the main chat never saw the exchange; the quote tells it so", async () => {
          await mainComposer(page).fill("What did you make of that?");
          await send(mainComposer(page));
          await waitForLastPrompt(claudeStub, "What did you make of that?");
          const received = claudeStub.lastUserText(claudeStub.requests.at(-1)!);
          expect(received).toContain(
            "> [Quoted from your answer to a side question. That exchange is not in this conversation.]",
          );
          const mainHistory = JSON.stringify(claudeStub.requests.at(-1)!.messages);
          expect(mainHistory).not.toContain("Why 45000?");
          expect(mainHistory).not.toContain("SCRIPT-SIDE");
        });

        await test.step("the Side questions pill lists it, and archiving it empties the list", async () => {
          const pill = page.getByTestId("side-questions-track-header");
          await expect(pill).toBeVisible();
          await expect(pill).toContainText("Side questions");
          await pill.click();
          await expect(page.getByTestId("side-questions-archive-all")).toBeVisible();
          await shot(page, `${viewport.name}-side-questions-list`);
          await page.getByTestId("side-questions-archive-all").click();
          await expect(pill).toHaveCount(0);
        });
      } finally {
        await chat.close();
      }
    });

    test("an earlier reply asks about itself by default, and /btw asks without messaging the agent", async ({
      page,
      claudeStub,
    }) => {
      const chat = await seedChat(claudeStub);
      try {
        await chat.client.sendAgentMessage(chat.agentId, "a second turn");
        await chat.client.waitForFinish(chat.agentId, 60_000);
        await openAgentRoute(page, { workspaceId: chat.workspaceId, agentId: chat.agentId });
        await expect(page.getByTestId("assistant-message")).toHaveCount(2, { timeout: 30_000 });

        await test.step("the earlier reply's button is a menu with both choices", async () => {
          await page.getByTestId("turn-ask-aside-menu").first().click();
          await expect(page.getByTestId("turn-ask-aside-about")).toBeVisible();
          await expect(page.getByTestId("turn-ask-aside-from")).toBeVisible();
          await shot(page, `${viewport.name}-ask-aside-menu`);
          await page.getByTestId("turn-ask-aside-from").click();
          await expect(page.getByTestId("side-question-context")).toContainText(
            "up to an earlier reply",
            { timeout: 30_000 },
          );
        });

        await test.step("an empty side question is discarded when it is closed or archived", async () => {
          if (viewport.name === "phone") {
            await closeSheet(page, "Side question");
          } else {
            await page.getByTestId("side-question-menu").click();
            await page.getByTestId("side-question-archive").click();
          }
          await expect(page.getByTestId("side-questions-track-header")).toHaveCount(0, {
            timeout: 15_000,
          });
        });

        await test.step("/btw sends the question to a side question, not to the agent", async () => {
          await mainComposer(page).fill("/btw what is the default?");
          await send(mainComposer(page));
          await waitForLastPrompt(claudeStub, "what is the default?");
          const received = claudeStub.lastUserText(claudeStub.requests.at(-1)!);
          expect(received).toContain("what is the default?");
          expect(received).toContain("This is a side question");
          await expect(mainComposer(page)).toHaveValue("");
        });
      } finally {
        await chat.close();
      }
    });
  });
}
