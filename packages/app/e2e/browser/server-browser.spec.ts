import http from "node:http";
import { expect, test } from "../support/fixtures";
import { openAgentRoute } from "../support/helpers/mock-agent";
import {
  SERVER_BROWSER_DAEMON_CONFIG,
  startServerBrowserScenario,
  type ServerBrowserScenario,
} from "../support/helpers/server-browser";

test.use({ e2eInjectPaseoTools: true, e2eDaemonConfig: SERVER_BROWSER_DAEMON_CONFIG });

let scenario: ServerBrowserScenario;

// A page that shows every key it receives as its title.
const KEY_LOG_PAGE =
  "<title>keys:</title><p>keys</p><script>" +
  "addEventListener('keydown', (e) => { document.title += e.key + ','; });" +
  "</script>";

test.beforeEach(async () => {
  scenario = await startServerBrowserScenario({ "/keys": KEY_LOG_PAGE });
});

test.afterEach(async () => {
  await scenario.close();
});

test("closing a server tab's workspace tab closes it on the host", async ({ page }) => {
  const browserId = await scenario.newTab();
  await page.setViewportSize({ width: 1400, height: 900 });
  await openAgentRoute(page, {
    workspaceId: scenario.workspace.workspaceId,
    agentId: scenario.agentId,
  });
  const tab = page.getByTestId(`workspace-tab-server_browser_${browserId}`);
  await expect(tab).toBeVisible();

  await tab.hover();
  await page.getByTestId(`workspace-server-browser-close-${browserId}`).click();

  await expect(tab).toHaveCount(0);
  await expect.poll(() => scenario.listTabIds()).not.toContain(browserId);
});

test("Stop ends a load, and a failed load shows the card whose Retry loads the page", async ({
  page,
}) => {
  const slow = await scenario.newTab("/slow");
  const refusedServer = http.createServer((_req, res) => res.end("<title>Up</title><p>up now</p>"));
  await new Promise<void>((resolve) => refusedServer.listen(0, "127.0.0.1", resolve));
  const address = refusedServer.address();
  const refused = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
  await new Promise<void>((resolve) => refusedServer.close(() => resolve()));
  const failed = await scenario.newTabAt(refused);
  await page.setViewportSize({ width: 1400, height: 900 });
  await openAgentRoute(page, {
    workspaceId: scenario.workspace.workspaceId,
    agentId: scenario.agentId,
  });

  await page.getByTestId(`workspace-tab-server_browser_${slow}`).click();
  await page.getByTestId("server-browser-stop").click();
  await expect(page.getByTestId("server-browser-reload")).toBeVisible();
  await expect.poll(async () => (await scenario.tabInfo(slow))?.isLoading).toBe(false);

  await page.getByTestId(`workspace-tab-server_browser_${failed}`).click();
  const card = page.getByTestId("browser-load-failure");
  await expect(card).toContainText("net::ERR_CONNECTION_REFUSED");
  await expect(card).toContainText(refused);
  await page.screenshot({ path: test.info().outputPath("load-failure.png") });
  await new Promise<void>((resolve) =>
    refusedServer.listen(Number(new URL(refused).port), "127.0.0.1", resolve),
  );
  try {
    await page.getByTestId("browser-load-retry").click();
    await expect(card).toHaveCount(0);
    await expect.poll(async () => (await scenario.tabInfo(failed))?.title).toBe("Up");
  } finally {
    await new Promise<void>((resolve) => refusedServer.close(() => resolve()));
  }
});

for (const platform of ["Linux", "MacIntel"] as const) {
  test(`app shortcuts work while the viewer has focus, and only page keys reach the page (${platform})`, async ({
    page,
  }) => {
    const mod = platform === "MacIntel" ? "Meta" : "Control";
    await page.addInitScript((value) => {
      Object.defineProperty(navigator, "platform", { get: () => value });
    }, platform);
    const browserId = await scenario.newTab("/keys");
    await page.setViewportSize({ width: 1400, height: 900 });
    await openAgentRoute(page, {
      workspaceId: scenario.workspace.workspaceId,
      agentId: scenario.agentId,
    });
    await page.getByTestId(`workspace-tab-server_browser_${browserId}`).click();
    const surface = page.getByTestId("server-browser-surface");
    await surface.click();
    const pageTitle = async () => String((await scenario.tabInfo(browserId))?.title ?? "");

    // Typing, including a key an app shortcut takes outside a text field (?), goes to the page.
    await page.keyboard.type("a");
    await page.keyboard.press("Shift+Slash");
    await expect.poll(pageTitle).toBe("keys:a,Shift,?,");
    await expect(page.getByTestId("keyboard-shortcuts-dialog")).toHaveCount(0);

    // The command palette opens over the page and the page never sees its key.
    await page.keyboard.press(`${mod}+K`);
    await expect(page.getByTestId("command-center-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-center-panel")).toHaveCount(0);
    await surface.click();
    await page.keyboard.type("b");
    await expect.poll(pageTitle).toBe(`keys:a,Shift,?,${mod},b,`);

    // Closing the tab from the keyboard closes the server tab (Alt+Shift+W in a browser).
    await page.keyboard.press("Alt+Shift+W");
    await expect(page.getByTestId(`workspace-tab-server_browser_${browserId}`)).toHaveCount(0);
    await expect.poll(() => scenario.listTabIds()).not.toContain(browserId);
  });
}
