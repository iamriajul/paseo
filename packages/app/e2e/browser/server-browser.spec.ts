import { expect, test } from "../support/fixtures";
import { openAgentRoute } from "../support/helpers/mock-agent";
import {
  SERVER_BROWSER_DAEMON_CONFIG,
  startServerBrowserScenario,
  type ServerBrowserScenario,
} from "../support/helpers/server-browser";

test.use({ e2eInjectPaseoTools: true, e2eDaemonConfig: SERVER_BROWSER_DAEMON_CONFIG });

let scenario: ServerBrowserScenario;

test.beforeEach(async () => {
  scenario = await startServerBrowserScenario();
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
