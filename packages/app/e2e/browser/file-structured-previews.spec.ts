import { appendFile, writeFile } from "node:fs/promises";
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

test("CSV opens as a table and JSON as a foldable tree, with Source a tap away", async ({
  page,
}) => {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "file-structured-previews-",
    title: "Structured previews",
  });
  try {
    await writeFile(
      path.join(session.cwd, "people.csv"),
      'name,age,city\n"Smith, Ann",41,Oslo\nBo,7,"Rio ""de"" Janeiro"\n',
    );
    await writeFile(
      path.join(session.cwd, "tsconfig.json"),
      '{\n  // shared\n  "compilerOptions": { "strict": true, "paths": { "@/*": ["src/*"] }, },\n  "include": ["src"],\n}\n',
    );
    await writeFile(path.join(session.cwd, "broken.json"), '{\n  "a": 1\n  "b": 2\n}\n');
    await openAgentRoute(page, session);

    await openWorkspaceFile(page, "people.csv");
    const table = visible(page, "file-table-preview");
    await expect(table).toBeVisible({ timeout: 30_000 });
    await expect(visible(page, "file-table-header")).toContainText("city");
    await expect(table.getByText("Smith, Ann", { exact: true })).toBeVisible();
    await expect(table.getByText('Rio "de" Janeiro', { exact: true })).toBeVisible();
    await visible(page, "file-mode-source").click();
    await expect(visible(page, "file-table-preview")).toHaveCount(0);

    await openWorkspaceFile(page, "tsconfig.json");
    const tree = visible(page, "file-json-preview");
    await expect(tree).toBeVisible({ timeout: 30_000 });
    await expect(tree.getByText('"strict"').first()).toBeVisible();
    await expect(tree.getByText('"src/*"').first()).toBeVisible();
    await tree.getByText('"compilerOptions"').first().click();
    await expect(tree.getByText('"strict"')).toHaveCount(0);
    await expect(tree.getByText("2 keys").first()).toBeVisible();

    await openWorkspaceFile(page, "broken.json");
    await expect(visible(page, "file-json-error")).toContainText("line 3");
  } finally {
    await session.cleanup();
  }
});

test("a log opens on its end and follows lines appended to it", async ({ page }) => {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "file-log-tail-",
    title: "Log tail",
  });
  try {
    const lines = Array.from(
      { length: 20_000 },
      (_, index) => `\u001b[32mINFO\u001b[0m request ${index} handled`,
    );
    const log = path.join(session.cwd, "server.log");
    await writeFile(log, `${lines.join("\n")}\n`);
    await openAgentRoute(page, session);
    await openWorkspaceFile(page, "server.log");

    const tail = visible(page, "file-log-tail");
    await expect(tail.getByText("INFO request 19999 handled")).toBeVisible({ timeout: 30_000 });
    await expect(tail.getByText("request 0 handled", { exact: false })).toHaveCount(0);
    await expect(visible(page, "file-log-load-earlier")).toBeVisible();

    await appendFile(log, "INFO request 20000 appended\n");
    await expect(tail.getByText("INFO request 20000 appended")).toBeVisible({ timeout: 30_000 });

    await visible(page, "file-mode-source").click();
    await expect(page.locator(".cm-content").filter({ visible: true }).first()).toBeVisible();
  } finally {
    await session.cleanup();
  }
});
