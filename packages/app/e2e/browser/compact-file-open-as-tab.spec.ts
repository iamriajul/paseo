import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  expectNoSheetOpen,
  expectOpenTabCount,
  openSheetAsTab,
  selectTabFromSwitcher,
  sheet,
  sheetHeader,
} from "../support/helpers/sheet";

const FILE_NAME = "notes.md";

function promptMentioning(target: string): string {
  return [
    "Generate a title and a git branch name for a coding agent from the user prompt and attachments.",
    "Return JSON only with fields 'title' and 'branch'.",
    "",
    "<user-prompt>",
    `Open \`${target}\` now`,
    "</user-prompt>",
  ].join("\n");
}

test("a phone opens a file sheet as a tab, once its edits are saved", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "compact-file-open-as-tab-",
    title: "Notes parent",
    initialPrompt: promptMentioning(FILE_NAME),
  });
  try {
    const gate = await installDaemonWebSocketGate(page);
    const filePath = path.join(workspace.cwd, FILE_NAME);
    await writeFile(filePath, "# Rendered heading\n", "utf8");
    await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: workspace.agentId });
    await expectOpenTabCount(page, 1);
    const fileLink = page.getByText(FILE_NAME, { exact: true });
    const openAsTab = sheetHeader(page, FILE_NAME).getByRole("button", { name: "Open as tab" });

    await test.step("the file sheet offers Open as tab", async () => {
      await expect(fileLink).toBeVisible({ timeout: 15_000 });
      await fileLink.click();
      await expect(sheet(page, FILE_NAME).getByText("Rendered heading")).toBeVisible();
      await expect(openAsTab).toBeVisible();
    });

    await test.step("unsaved edits hide Open as tab until they are saved", async () => {
      const fileSheet = sheet(page, FILE_NAME);
      await fileSheet.getByTestId("file-mode-source").click();
      const editor = fileSheet.getByTestId("file-source-editor").locator(".cm-content");
      gate.holdNextClientRequest("fs.file.write.request");
      await editor.click();
      await editor.press("ControlOrMeta+A");
      await editor.pressSequentially("# Edited heading");
      await gate.waitForHeldClientRequest();
      await expect(openAsTab).toHaveCount(0);

      gate.releaseHeldClientRequest();
      await expect.poll(() => readFile(filePath, "utf8")).toBe("# Edited heading");
      await expect(openAsTab).toBeVisible();
    });

    await test.step("Open as tab moves the file into the tab switcher", async () => {
      await openSheetAsTab(page, FILE_NAME);
      await expectNoSheetOpen(page);
      await expectOpenTabCount(page, 2);
      await expect(
        page
          .getByTestId("workspace-file-pane")
          .filter({ visible: true })
          .getByText("Edited heading"),
      ).toBeVisible();
    });

    await test.step("the chat link then reveals the file's tab, not a new sheet", async () => {
      await selectTabFromSwitcher(page, "Notes parent");
      await fileLink.click();
      await expectNoSheetOpen(page);
      await expectOpenTabCount(page, 2);
      await expect(
        page
          .getByTestId("workspace-file-pane")
          .filter({ visible: true })
          .getByText("Edited heading"),
      ).toBeVisible();
    });
  } finally {
    await workspace.cleanup();
  }
});
