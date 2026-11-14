import { readFile, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import {
  expectFileTabOpen,
  openFileExplorer,
  openFileFromExplorer,
} from "../support/helpers/file-explorer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

async function openWorkspaceFile(page: Page, fileName: string): Promise<void> {
  const tree = page.getByTestId("file-explorer-tree-scroll");
  if (!(await tree.isVisible())) await openFileExplorer(page);
  await openFileFromExplorer(page, fileName);
  await expectFileTabOpen(page, fileName);
}

function visible(page: Page, testId: string) {
  return page.getByTestId(testId).filter({ visible: true });
}

test.describe("File tab actions", () => {
  test("a changed file shows its changes and opens them in Changes", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "file-tab-changes-",
      title: "File tab changes",
      repo: { files: [{ path: "notes.txt", content: "one\ntwo\n" }] },
    });
    try {
      await writeFile(path.join(session.cwd, "notes.txt"), "one\nthree\nfour\n");
      await session.client.checkoutRefresh(session.cwd);
      await page.setViewportSize({ width: 1400, height: 900 });
      await openAgentRoute(page, session);

      await openWorkspaceFile(page, "README.md");
      await expect(visible(page, "file-download")).toBeVisible({ timeout: 30_000 });
      await expect(visible(page, "file-show-changes")).toHaveCount(0);

      await openWorkspaceFile(page, "notes.txt");
      const showChanges = visible(page, "file-show-changes");
      await expect(showChanges).toBeVisible({ timeout: 30_000 });
      await expect(showChanges).toContainText("+2");
      await expect(showChanges).toContainText("-1");

      await showChanges.click();
      const diff = visible(page, "working-diff-panel");
      await expect(diff).toBeVisible({ timeout: 30_000 });
      await expect(diff.getByTestId("diff-file-0")).toHaveAccessibleName("notes.txt, +2, -1", {
        timeout: 30_000,
      });
    } finally {
      await session.cleanup();
    }
  });

  test("downloads the file from its tab with its name and bytes", async ({ page }, testInfo) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "file-tab-download-",
      title: "File tab download",
    });
    try {
      const source = Buffer.from([0, 1, 2, 127, 128, 255, 10]);
      await writeFile(path.join(session.cwd, "payload.bin"), source);
      await openAgentRoute(page, session);
      await openWorkspaceFile(page, "payload.bin");
      await expect(visible(page, "file-download-instead")).toBeVisible({ timeout: 30_000 });

      const downloaded = page.waitForEvent("download");
      await visible(page, "file-download").click();
      const download = await downloaded;
      expect(download.suggestedFilename()).toBe("payload.bin");
      const saved = testInfo.outputPath("payload.bin");
      await download.saveAs(saved);
      expect(await readFile(saved)).toEqual(source);
    } finally {
      await session.cleanup();
    }
  });

  test("a PDF too large to read whole offers its download instead", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "file-tab-too-large-",
      title: "File tab too large",
    });
    try {
      const big = path.join(session.cwd, "scan.pdf");
      await writeFile(big, "%PDF-1.4\n");
      await truncate(big, 64 * 1024 * 1024 + 1);
      await openAgentRoute(page, session);
      await openWorkspaceFile(page, "scan.pdf");

      await expect(visible(page, "file-too-large-to-preview")).toBeVisible({ timeout: 30_000 });
      await expect(visible(page, "file-tab-toolbar")).toContainText("64.0 MB");
      await expect(visible(page, "file-download-instead")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });
});
