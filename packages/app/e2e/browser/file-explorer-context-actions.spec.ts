import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import {
  downloadFileFromExplorer,
  downloadFolderFromExplorer,
  downloadOpenFolder,
  openFileExplorer,
} from "../support/helpers/file-explorer";
import { openChangesPanel } from "../support/helpers/workspace-tabs";
import { gotoWorkspace } from "../support/helpers/launcher";
import { daemonWsRoutePattern, getE2EDaemonPort } from "../support/helpers/daemon-port";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

let workspace: SeededWorkspace;

async function failNextDeleteRequest(page: Page): Promise<void> {
  await page.routeWebSocket(daemonWsRoutePattern(), (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    browserSocket.onMessage((message) => {
      if (typeof message === "string") {
        const envelope = JSON.parse(message) as {
          message?: { type?: string; cwd?: string; path?: string; requestId?: string };
        };
        if (envelope.message?.type === "fs.entry.delete.request") {
          browserSocket.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "fs.entry.delete.response",
                payload: {
                  cwd: envelope.message.cwd,
                  path: envelope.message.path,
                  success: false,
                  error: "Injected delete failure",
                  requestId: envelope.message.requestId,
                },
              },
            }),
          );
          return;
        }
      }
      serverSocket.send(message);
    });
    serverSocket.onMessage((message) => browserSocket.send(message));
  });
}

async function hideContextActionCapabilities(page: Page): Promise<void> {
  await page.routeWebSocket(daemonWsRoutePattern(), (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    browserSocket.onMessage((message) => serverSocket.send(message));
    serverSocket.onMessage((message) => {
      if (typeof message !== "string") {
        browserSocket.send(message);
        return;
      }
      const envelope = JSON.parse(message) as {
        message?: {
          type?: string;
          payload?: { status?: string; features?: Record<string, unknown> };
        };
      };
      if (
        envelope.message?.type === "status" &&
        envelope.message.payload?.status === "server_info"
      ) {
        envelope.message.payload.features = {
          ...envelope.message.payload.features,
          fsEntryOps: false,
          fsEntryDuplicate: false,
          checkoutDiscardChanges: false,
        };
      }
      browserSocket.send(JSON.stringify(envelope));
    });
  });
}

async function disconnectNextContextAction(page: Page): Promise<{ wait: () => Promise<void> }> {
  let resolveRequest: (() => void) | undefined;
  const requestSeen = new Promise<void>((resolve) => {
    resolveRequest = resolve;
  });

  await page.routeWebSocket(daemonWsRoutePattern(), (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    browserSocket.onMessage((message) => {
      if (typeof message === "string") {
        const envelope = JSON.parse(message) as { message?: { type?: string } };
        const type = envelope.message?.type;
        if (type?.startsWith("fs.entry.") || type === "checkout.discard_changes.request") {
          resolveRequest?.();
          void browserSocket.close({
            code: 1008,
            reason: "Context action connection failed",
          });
          return;
        }
      }
      serverSocket.send(message);
    });
    serverSocket.onMessage((message) => browserSocket.send(message));
  });

  return { wait: () => requestSeen };
}

test.beforeEach(async () => {
  workspace = await seedWorkspace({ repoPrefix: "file-explorer-context-actions-" });
});

test.afterEach(async () => {
  await workspace?.cleanup();
});

test("creates, renames, copies, and deletes entries through the file explorer", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await gotoWorkspace(page, workspace.workspaceId);
  await openFileExplorer(page);

  const tree = page.getByTestId("file-explorer-tree-scroll");
  const entry = (name: string) => tree.getByText(name, { exact: true }).first();
  const nameInput = page.getByTestId("file-explorer-name-input");

  await page.getByTestId("files-new-folder").click();
  await expect(nameInput).toBeVisible();
  const draftRow = nameInput.locator("xpath=..");
  const placeholderColor = await nameInput.evaluate(
    (input) => getComputedStyle(input, "::placeholder").color,
  );
  const extraMutedChevronColor = await draftRow
    .locator("svg")
    .evaluate((icon) => getComputedStyle(icon).stroke);
  expect(placeholderColor).toBe(extraMutedChevronColor);
  await nameInput.press("Tab");
  await expect(nameInput).toBeHidden();

  await page.getByTestId("files-new-file").click();
  await nameInput.fill("README.md");
  await nameInput.press("Enter");
  await expect(page.getByText('"README.md" already exists', { exact: true })).toBeVisible();

  const emptyArea = page.getByTestId("files-empty-area");
  await expect(emptyArea).toBeVisible();
  const emptyAreaBounds = await emptyArea.boundingBox();
  expect(emptyAreaBounds).not.toBeNull();
  await emptyArea.click({
    button: "right",
    position: { x: emptyAreaBounds!.width / 2, y: emptyAreaBounds!.height - 24 },
  });
  await expect(page.getByTestId("files-empty-area-new-file")).toBeVisible();
  await page.getByTestId("files-empty-area-new-folder").click();
  await nameInput.fill("folder");
  await nameInput.press("Enter");
  await expect(entry("folder")).toBeVisible();

  await entry("folder").click({ button: "right" });
  await page.getByText("New file", { exact: true }).click();
  await nameInput.fill("child.txt");
  await nameInput.press("Enter");
  await expect(entry("child.txt")).toBeVisible();

  await entry("folder").click({ button: "right" });
  await page.getByText("New folder", { exact: true }).click();
  await nameInput.fill("nested");
  await nameInput.press("Enter");
  await entry("nested").click({ button: "right" });
  await page.getByText("New folder", { exact: true }).click();
  await nameInput.fill("deep");
  await nameInput.press("Enter");
  await expect(entry("deep")).toBeVisible();

  await entry("folder").click({ button: "right" });
  await page.getByText("Collapse folder", { exact: true }).click();
  await expect(entry("child.txt")).toBeHidden();
  await expect(entry("nested")).toBeHidden();
  await expect(entry("deep")).toBeHidden();

  await entry("folder").click();
  await expect(entry("child.txt")).toBeVisible();
  await expect(entry("nested")).toBeVisible();
  await expect(entry("deep")).toBeHidden();
  await entry("nested").click();
  await expect(entry("deep")).toBeVisible();

  await page.getByTestId("files-new-file").click();
  await nameInput.fill("created.txt");
  await nameInput.press("Enter");
  await expect(entry("created.txt")).toBeVisible();
  await expect(entry("created.txt")).toHaveCSS("user-select", "none");
  await entry("created.txt").dblclick();
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");

  const folderRow = entry("folder").locator(
    "xpath=ancestor::*[starts-with(@data-testid, 'file-explorer-row-')][1]",
  );
  const fileRow = entry("created.txt").locator(
    "xpath=ancestor::*[starts-with(@data-testid, 'file-explorer-row-')][1]",
  );
  await expect(folderRow.locator("svg")).toHaveCount(1);
  await expect(fileRow.locator("svg")).toHaveCount(1);
  const gitRow = entry(".git").locator(
    "xpath=ancestor::*[starts-with(@data-testid, 'file-explorer-row-')][1]",
  );
  const collapsedChevronBounds = await gitRow.locator("svg").first().boundingBox();
  const expandedChevronBounds = await folderRow.locator("svg").first().boundingBox();
  const collapsedChevronSlotBounds = await gitRow
    .locator("svg")
    .first()
    .locator("xpath=../..")
    .boundingBox();
  const expandedChevronSlotBounds = await folderRow
    .locator("svg")
    .first()
    .locator("xpath=../..")
    .boundingBox();
  expect(collapsedChevronBounds).not.toBeNull();
  expect(expandedChevronBounds).not.toBeNull();
  expect(collapsedChevronSlotBounds).not.toBeNull();
  expect(expandedChevronSlotBounds).not.toBeNull();
  const collapsedChevronCenter = collapsedChevronBounds!.x + collapsedChevronBounds!.width / 2;
  const expandedChevronCenter = expandedChevronBounds!.x + expandedChevronBounds!.width / 2;
  expect(collapsedChevronCenter).toBeCloseTo(expandedChevronCenter, 0);
  expect(collapsedChevronCenter).toBeCloseTo(
    collapsedChevronSlotBounds!.x + collapsedChevronSlotBounds!.width / 2,
    0,
  );
  expect(expandedChevronCenter).toBeCloseTo(
    expandedChevronSlotBounds!.x + expandedChevronSlotBounds!.width / 2,
    0,
  );
  const folderLabelBounds = await entry("folder").boundingBox();
  const fileLabelBounds = await entry("created.txt").boundingBox();
  expect(folderLabelBounds).not.toBeNull();
  expect(fileLabelBounds).not.toBeNull();
  expect(fileLabelBounds!.x).toBeCloseTo(folderLabelBounds!.x, 0);

  await folderRow.click();
  await expect(folderRow).toHaveAttribute("aria-selected", "true");
  await expect(entry("child.txt")).toBeHidden();
  await folderRow.click();
  await expect(folderRow).toHaveAttribute("aria-selected", "true");
  await expect(entry("child.txt")).toBeVisible();

  await entry("folder").click({ button: "right" });
  await page.getByText("Rename", { exact: true }).click();
  await nameInput.fill("renamed-folder");
  await nameInput.press("Tab");
  await expect(entry("renamed-folder")).toBeVisible();
  await expect(entry("folder")).toBeHidden();
  await expect(entry("child.txt")).toBeVisible();
  const renamedFolderRow = entry("renamed-folder").locator(
    "xpath=ancestor::*[starts-with(@data-testid, 'file-explorer-row-')][1]",
  );
  await expect(renamedFolderRow).toHaveAttribute("aria-selected", "true");

  await entry("created.txt").click({ button: "right" });
  await expect(fileRow).toHaveAttribute("aria-selected", "true");
  await expect(renamedFolderRow).toHaveAttribute("aria-selected", "false");
  const menu = page.getByTestId(/file-explorer-row-\d+-context-menu$/);
  await expect(menu).toBeVisible();

  await page.getByText("Copy path", { exact: true }).click({ button: "right" });
  await expect(menu).toBeVisible();

  const backdrop = page.getByTestId(/file-explorer-row-\d+-context-menu-backdrop$/);
  await backdrop.click({ button: "right" });
  await expect(menu).toBeHidden();

  await entry("created.txt").click({ button: "right" });
  await page.getByText("Rename", { exact: true }).click();
  await expect(nameInput).toHaveValue("created.txt");
  await nameInput.press("Escape");
  await expect(entry("created.txt")).toBeVisible();

  await entry("created.txt").click({ button: "right" });
  await page.getByText("Rename", { exact: true }).click();
  await nameInput.fill("README.md");
  await nameInput.press("Enter");
  await expect(page.getByText('"README.md" already exists', { exact: true })).toBeVisible();
  await expect(entry("created.txt")).toBeVisible();

  await entry("created.txt").click({ button: "right" });
  await page.getByText("Rename", { exact: true }).click();
  await nameInput.fill("renamed.txt");
  await nameInput.press("Tab");
  await expect(entry("renamed.txt")).toBeVisible();
  await expect(entry("created.txt")).toBeHidden();

  await entry("renamed.txt").click({ button: "right" });
  await page.getByText("Copy relative path", { exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("renamed.txt");

  await entry("renamed.txt").click({ button: "right" });
  // The menu first renders a hidden copy to measure, then remounts it where it belongs. Read
  // styles from the placed copy: the measuring one is detached on placement, and a detached
  // element's computed style is empty.
  const deleteAction = page.getByTestId(/file-explorer-row-\d+-delete$/).filter({ visible: true });
  await expect(deleteAction).toBeVisible();
  const deleteLabelColor = await deleteAction
    .getByText("Delete", { exact: true })
    .evaluate((element) => getComputedStyle(element).color);
  await expect(deleteAction.locator("svg")).toHaveCSS("stroke", deleteLabelColor);
  const cancelledConfirmation = new Promise<string>((resolve) => {
    page.once("dialog", async (dialog) => {
      const message = dialog.message();
      await dialog.dismiss();
      resolve(message);
    });
  });
  await page.getByText("Delete", { exact: true }).click();
  expect(await cancelledConfirmation).toContain("renamed.txt");
  await expect(entry("renamed.txt")).toBeVisible();

  await entry("renamed.txt").click({ button: "right" });
  const confirmation = new Promise<string>((resolve) => {
    page.once("dialog", async (dialog) => {
      const message = dialog.message();
      await dialog.accept();
      resolve(message);
    });
  });
  await page.getByText("Delete", { exact: true }).click();
  expect(await confirmation).toContain("renamed.txt");
  await expect(entry("renamed.txt")).toBeHidden();

  await entry("renamed-folder").click({ button: "right" });
  const folderConfirmation = new Promise<string>((resolve) => {
    page.once("dialog", async (dialog) => {
      const message = dialog.message();
      await dialog.accept();
      resolve(message);
    });
  });
  await page.getByText("Delete", { exact: true }).click();
  expect(await folderConfirmation).toContain("renamed-folder");
  await expect(entry("renamed-folder")).toBeHidden();
  await expect(entry("child.txt")).toBeHidden();
});

test("duplicates files and folders with collision-free names", async ({ page }) => {
  const sourceFilePath = path.join(workspace.repoPath, "duplicate-source.txt");
  const sourceFolderPath = path.join(workspace.repoPath, "duplicate-folder");
  await writeFile(sourceFilePath, "duplicate contents", "utf8");
  await mkdir(sourceFolderPath);
  await writeFile(path.join(sourceFolderPath, "nested.txt"), "nested contents", "utf8");

  try {
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileExplorer(page);

    const tree = page.getByTestId("file-explorer-tree-scroll");
    const entry = (name: string) => tree.getByText(name, { exact: true }).first();

    await entry("duplicate-source.txt").click({ button: "right" });
    await page.getByTestId(/file-explorer-row-\d+-duplicate$/).click();
    await expect(entry("duplicate-source copy.txt")).toBeVisible();
    await expect
      .poll(() => readFile(path.join(workspace.repoPath, "duplicate-source copy.txt"), "utf8"))
      .toBe("duplicate contents");

    await entry("duplicate-source.txt").click({ button: "right" });
    await page.getByTestId(/file-explorer-row-\d+-duplicate$/).click();
    await expect(entry("duplicate-source copy 2.txt")).toBeVisible();

    await entry("duplicate-folder").click({ button: "right" });
    await page.getByTestId(/file-explorer-row-\d+-duplicate$/).click();
    await expect(entry("duplicate-folder copy")).toBeVisible();
    await expect
      .poll(() =>
        readFile(path.join(workspace.repoPath, "duplicate-folder copy", "nested.txt"), "utf8"),
      )
      .toBe("nested contents");
  } finally {
    await Promise.all([
      rm(sourceFilePath, { force: true }),
      rm(path.join(workspace.repoPath, "duplicate-source copy.txt"), { force: true }),
      rm(path.join(workspace.repoPath, "duplicate-source copy 2.txt"), { force: true }),
      rm(sourceFolderPath, { recursive: true, force: true }),
      rm(path.join(workspace.repoPath, "duplicate-folder copy"), { recursive: true, force: true }),
    ]);
  }
});

test("shows an actionable error when the connection drops during creation", async ({ page }) => {
  const disconnect = await disconnectNextContextAction(page);
  await gotoWorkspace(page, workspace.workspaceId);
  await openFileExplorer(page);

  await page.getByTestId("files-new-file").click();
  const nameInput = page.getByTestId("file-explorer-name-input");
  await nameInput.fill("disconnected.txt");
  await nameInput.press("Enter");
  await disconnect.wait();

  await expect(page.getByText(/Context action connection failed/i)).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByTestId("file-explorer-tree-scroll").getByText("disconnected.txt", { exact: true }),
  ).toHaveCount(0);
});

test("keeps an entry visible when deletion fails", async ({ page }) => {
  await failNextDeleteRequest(page);
  await gotoWorkspace(page, workspace.workspaceId);
  await openFileExplorer(page);

  const readme = page
    .getByTestId("file-explorer-tree-scroll")
    .getByText("README.md", { exact: true });
  await readme.click({ button: "right" });
  const confirmation = new Promise<void>((resolve) => {
    page.once("dialog", async (dialog) => {
      await dialog.accept();
      resolve();
    });
  });
  await page.getByText("Delete", { exact: true }).click();
  await confirmation;

  await expect(page.getByText("Injected delete failure", { exact: true })).toBeVisible();
  await expect(readme).toBeVisible();
});

test("hides unsupported file operations and revert actions", async ({ page }) => {
  await hideContextActionCapabilities(page);
  await writeFile(path.join(workspace.repoPath, "README.md"), "# Changed while unsupported\n");
  await gotoWorkspace(page, workspace.workspaceId);
  await openFileExplorer(page);

  await expect(page.getByTestId("files-new-file")).toHaveCount(0);
  await expect(page.getByTestId("files-new-folder")).toHaveCount(0);
  await page
    .getByTestId("file-explorer-tree-scroll")
    .getByText("README.md", { exact: true })
    .click({ button: "right" });
  const filesMenu = page.getByTestId(/file-explorer-row-\d+-context-menu$/);
  await expect(filesMenu.getByText("Rename", { exact: true })).toHaveCount(0);
  await expect(filesMenu.getByText("Duplicate", { exact: true })).toHaveCount(0);
  await expect(filesMenu.getByText("Delete", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await openChangesPanel(page);
  await expect(page.getByTestId("diff-file-0")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("diff-file-0-toggle").click({ button: "right" });
  await expect(page.getByTestId("diff-file-0-duplicate")).toHaveCount(0);
  await expect(page.getByTestId("diff-file-0-revert")).toHaveCount(0);
});

test("downloads a file over direct TCP with its original filename and bytes", async ({
  page,
}, testInfo) => {
  const fileName = "rapport données.bin";
  const source = Buffer.from([0, 1, 2, 127, 128, 255, 10]);
  await writeFile(path.join(workspace.workspaceDirectory, fileName), source);
  await gotoWorkspace(page, workspace.workspaceId);
  await openFileExplorer(page);

  const downloaded = await downloadFileFromExplorer(page, fileName);
  const url = new URL(downloaded.url());
  expect(url.protocol).toBe("http:");
  expect(url.port).toBe(getE2EDaemonPort());
  expect(url.pathname).toBe("/api/files/download");
  expect(url.searchParams.get("token")).toBeTruthy();
  expect(downloaded.suggestedFilename()).toBe(fileName);
  const savedFile = testInfo.outputPath(fileName);
  await downloaded.saveAs(savedFile);
  expect(await downloaded.failure()).toBeNull();
  expect(await readFile(savedFile)).toEqual(source);
});

/** Every file under `root` as relative path → contents; empty folders end in "/". */
async function readTree(root: string): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};
  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length === 0) tree[`${prefix}/`] = "";
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child, relative);
      else tree[relative] = await readFile(child, "utf8");
    }
  }
  await walk(root, "");
  return tree;
}

async function unzipDownload(
  downloaded: Awaited<ReturnType<typeof downloadOpenFolder>>,
  directory: string,
): Promise<Record<string, string>> {
  expect(await downloaded.failure()).toBeNull();
  const zipPath = path.join(directory, downloaded.suggestedFilename());
  await downloaded.saveAs(zipPath);
  const extracted = path.join(directory, "extracted");
  execFileSync("unzip", ["-q", zipPath, "-d", extracted]);
  return readTree(extracted);
}

test("downloads a subfolder and the open folder as zips matching Files", async ({
  page,
}, testInfo) => {
  const root = workspace.workspaceDirectory;
  await mkdir(path.join(root, "assets", "deep"), { recursive: true });
  await mkdir(path.join(root, "assets", "empty"));
  await writeFile(path.join(root, "assets", "deep", "données.txt"), "deep file");
  await writeFile(path.join(root, "assets", "logo.svg"), "<svg/>");
  await writeFile(path.join(root, "assets", ".secret"), "hidden");
  await gotoWorkspace(page, workspace.workspaceId);
  await openFileExplorer(page);

  const subfolder = await downloadFolderFromExplorer(page, "assets");
  const url = new URL(subfolder.url());
  expect(url.port).toBe(getE2EDaemonPort());
  expect(url.pathname).toBe("/api/files/download");
  expect(subfolder.suggestedFilename()).toBe("assets.zip");
  expect(await unzipDownload(subfolder, testInfo.outputPath("subfolder"))).toEqual({
    "assets/.secret": "hidden",
    "assets/deep/données.txt": "deep file",
    "assets/empty/": "",
    "assets/logo.svg": "<svg/>",
  });

  // With hidden files hidden, the zip leaves out what Files hides (.git, dotfiles).
  await page.getByTestId("files-hidden-toggle").click();
  const openFolder = await downloadOpenFolder(page);
  const rootName = path.basename(root);
  expect(openFolder.suggestedFilename()).toBe(`${rootName}.zip`);
  const extracted = await unzipDownload(openFolder, testInfo.outputPath("root"));
  const expected = Object.fromEntries(
    Object.entries(await readTree(root))
      .filter(([relative]) => !relative.split("/").some((segment) => segment.startsWith(".")))
      .map(([relative, contents]) => [`${rootName}/${relative}`, contents]),
  );
  expect(extracted).toEqual(expected);
  expect(Object.keys(extracted)).toContain(`${rootName}/assets/logo.svg`);
});

test("downloads the open folder from the Files header at phone width", async ({
  page,
}, testInfo) => {
  await writeFile(path.join(workspace.workspaceDirectory, "phone.txt"), "from the phone");
  // A phone-width deep link lands on the project screen; open the workspace, then narrow.
  await gotoWorkspace(page, workspace.workspaceId);
  await page.setViewportSize({ width: 390, height: 844 });
  await openFileExplorer(page);
  await page
    .getByTestId("files-pane-header")
    .filter({ visible: true })
    .screenshot({ path: testInfo.outputPath("files-header-390.png") });

  const downloaded = await downloadOpenFolder(page);
  const rootName = path.basename(workspace.workspaceDirectory);
  const extracted = await unzipDownload(downloaded, testInfo.outputPath("phone"));
  expect(extracted[`${rootName}/phone.txt`]).toBe("from the phone");
});
