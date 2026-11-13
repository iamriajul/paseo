import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { connectSeedClient } from "../support/helpers/seed-client";
import { createTempGitRepo } from "../support/helpers/workspace";
import {
  archiveAgentFromDaemon,
  createMockIdleAgent,
  expectWorkspaceTabHidden,
  expectWorkspaceTabVisible,
  openWorkspaceWithAgents,
  reloadWorkspace,
  type ArchiveTabAgent,
} from "../support/helpers/archive-tab";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

function tabChip(page: Page, agentId: string) {
  return page.getByTestId(`workspace-tab-agent_${agentId}`).filter({ visible: true }).first();
}

function contextItem(page: Page, agentId: string, item: string) {
  return page.getByTestId(`workspace-tab-context-agent_${agentId}-${item}`);
}

async function openContextMenu(page: Page, agentId: string) {
  await tabChip(page, agentId).click({ button: "right" });
  await expect(page.getByTestId(`workspace-tab-context-agent_${agentId}`)).toBeVisible();
}

async function chooseFromContextMenu(page: Page, agentId: string, item: string) {
  await openContextMenu(page, agentId);
  await contextItem(page, agentId, item).click();
}

test.describe("Pinned workspace tabs", () => {
  let client: Awaited<ReturnType<typeof connectSeedClient>>;
  const cleanups: Array<() => Promise<unknown>> = [];

  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(async () => {
    client = await connectSeedClient();
  });

  test.afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup().catch(() => undefined);
  });

  test.afterAll(async () => {
    await client?.close().catch(() => undefined);
  });

  /** Each test gets its own workspace, so one test's tabs never show up in another's. */
  async function seedAgents(): Promise<{
    workspaceId: string;
    agents: [ArchiveTabAgent, ArchiveTabAgent];
  }> {
    const repo = await createTempGitRepo("pinned-tabs-");
    cleanups.push(() => repo.cleanup());
    const created = await client.createWorkspace({
      source: { kind: "directory", path: repo.path },
    });
    if (!created.workspace) {
      throw new Error(created.error ?? `Failed to create workspace ${repo.path}`);
    }
    const { id: workspaceId, projectId } = created.workspace;
    cleanups.push(() => client.removeProject(projectId));
    const suffix = randomUUID().slice(0, 8);
    const pinned = await createMockIdleAgent(client, {
      cwd: repo.path,
      workspaceId,
      title: `pinned-${suffix}`,
    });
    const other = await createMockIdleAgent(client, {
      cwd: repo.path,
      workspaceId,
      title: `other-${suffix}`,
    });
    return { workspaceId, agents: [pinned, other] };
  }

  test("a pinned tab survives every close path until it is unpinned", async ({
    page,
  }, testInfo) => {
    const {
      workspaceId,
      agents: [pinned, other],
    } = await seedAgents();
    await openWorkspaceWithAgents(page, [pinned, other]);

    await chooseFromContextMenu(page, pinned.id, "pin");
    await expect(
      tabChip(page, pinned.id).getByTestId("workspace-tab-pinned-indicator"),
    ).toBeVisible();
    await tabChip(page, pinned.id).hover();
    await expect(
      page.getByTestId(`workspace-agent-close-${pinned.id}`).filter({ visible: true }),
    ).toHaveCount(0);
    await page
      .getByTestId(`workspace-tab-agent_${pinned.id}`)
      .filter({ visible: true })
      .first()
      .screenshot({ path: testInfo.outputPath("pinned-tab-chip.png") });

    // The menu's Close is off.
    await openContextMenu(page, pinned.id);
    await expect(contextItem(page, pinned.id, "close")).toBeDisabled();
    await page.keyboard.press("Escape");

    // Middle-click.
    await tabChip(page, pinned.id).click({ button: "middle" });
    await expectWorkspaceTabVisible(page, pinned.id);

    // Close current tab (Alt+Shift+W on browser web; Electron's Ctrl+W runs the same action).
    await tabChip(page, pinned.id).click();
    await page.keyboard.press("Alt+Shift+W");
    await expectWorkspaceTabVisible(page, pinned.id);

    // Bulk closes skip it.
    await chooseFromContextMenu(page, other.id, "close-others");
    await expectWorkspaceTabVisible(page, pinned.id);
    await chooseFromContextMenu(page, other.id, "close-left");
    await expectWorkspaceTabVisible(page, pinned.id);
    await expectWorkspaceTabVisible(page, other.id);

    // Archiving its agent elsewhere leaves the tab, showing the archived agent.
    await archiveAgentFromDaemon(client, pinned.id);
    await tabChip(page, pinned.id).click();
    await expect(
      page.getByText("This agent is archived").filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 30_000 });

    // The pin survives a reload.
    await reloadWorkspace(page, workspaceId);
    await expect(
      tabChip(page, pinned.id).getByTestId("workspace-tab-pinned-indicator"),
    ).toBeVisible();

    // Unpinned, it closes like any tab.
    await chooseFromContextMenu(page, pinned.id, "unpin");
    await expect(
      tabChip(page, pinned.id).getByTestId("workspace-tab-pinned-indicator"),
    ).toHaveCount(0);
    await tabChip(page, pinned.id).hover();
    await page
      .getByTestId(`workspace-agent-close-${pinned.id}`)
      .filter({ visible: true })
      .first()
      .click();
    await expectWorkspaceTabHidden(page, pinned.id);
    await expectWorkspaceTabVisible(page, other.id);
  });

  test.describe("on a phone", () => {
    test.use({ viewport: MOBILE_VIEWPORT });

    test("pins and unpins from the tab switcher, and Close stays off while pinned", async ({
      page,
    }, testInfo) => {
      const {
        workspaceId,
        agents: [pinned, other],
      } = await seedAgents();
      for (const agent of [other, pinned]) {
        await openAgentRoute(page, { workspaceId, agentId: agent.id });
      }
      await expect(page.getByRole("button", { name: /Switch tabs/ })).toHaveText("2", {
        timeout: 30_000,
      });
      const menuBase = `workspace-tab-menu-agent_${pinned.id}`;
      const switcher = page.getByRole("button", { name: /Switch tabs/ });
      const switcherSheet = page
        .getByRole("slider", { name: "Bottom Sheet" })
        .filter({ hasText: "Workspace tabs" });
      const openActions = async () => {
        await switcher.click();
        await page.getByTestId(`${menuBase}-trigger`).click();
      };
      // Picking a tab dismisses the switcher, and with it any actions sheet left over it.
      const closeSheets = async () => {
        const backdrop = page.getByRole("button", { name: "Bottom sheet backdrop" });
        if ((await backdrop.count()) === 0) return;
        await switcherSheet.getByText(other.title, { exact: true }).click();
        await expect(backdrop).toHaveCount(0);
      };

      await openActions();
      await page.getByTestId(`${menuBase}-pin`).click();
      await closeSheets();

      await switcher.click();
      const row = page.getByTestId(`${menuBase}-trigger`).locator("xpath=ancestor::*[3]");
      await expect(row.getByTestId("workspace-tab-pinned-indicator")).toBeVisible();
      await switcherSheet.screenshot({ path: testInfo.outputPath("pinned-tab-switcher.png") });
      await closeSheets();

      // Close other tabs from the other tab's actions skips the pinned one.
      const otherMenuBase = `workspace-tab-menu-agent_${other.id}`;
      await switcher.click();
      await page.getByTestId(`${otherMenuBase}-trigger`).click();
      await page.getByTestId(`${otherMenuBase}-close-others`).click();
      await closeSheets();
      await expect(switcher).toHaveText("2");

      // Close is off while pinned; Unpin from the same actions.
      await openActions();
      await expect(page.getByTestId(`${menuBase}-close`)).toBeDisabled();
      await page.getByTestId(`${menuBase}-unpin`).click();
      await closeSheets();
      await openActions();
      await page.getByTestId(`${menuBase}-close`).click();
      await closeSheets();
      await expect(switcher).toHaveText("1");
    });
  });
});
