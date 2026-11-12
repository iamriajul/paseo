import { expect, test } from "../support/fixtures";
import { openAgentRoute } from "../support/helpers/mock-agent";
import {
  SERVER_BROWSER_DAEMON_CONFIG,
  startServerBrowserScenario,
  type ServerBrowserScenario,
} from "../support/helpers/server-browser";

// Fork: server-browser-suspend-idle-tabs in docs/fork-decisions.md. A tab nobody watches or uses
// for 2 s is suspended; its own worker daemon, so the other server browser specs keep the default.
test.use({
  e2eInjectPaseoTools: true,
  e2eDaemonConfig: SERVER_BROWSER_DAEMON_CONFIG,
  e2eDaemonEnvironment: { PASEO_SERVER_BROWSER_TAB_IDLE_MS: "2000" },
});

const LONG_PAGE =
  "<title>Long</title><style>body{margin:0}</style>" +
  "<div style='height:6000px;background:linear-gradient(#3b82f6,#f97316)'>long</div>";

let scenario: ServerBrowserScenario;

test.beforeEach(async () => {
  scenario = await startServerBrowserScenario({ "/long": LONG_PAGE });
});

test.afterEach(async () => {
  await scenario.close();
});

test("an idle tab suspends, and opening it shows the page again at the same URL and scroll", async ({
  page,
}) => {
  const browserId = await scenario.newTab("/long");
  await scenario.tool("browser_evaluate", { browserId, function: "() => window.scrollTo(0, 900)" });
  await expect
    .poll(async () => (await scenario.tabInfo(browserId))?.suspended, { timeout: 20_000 })
    .toBe(true);
  expect(await scenario.tabInfo(browserId)).toMatchObject({
    url: `${scenario.siteUrl}/long`,
    title: "Long",
  });

  await page.setViewportSize({ width: 1400, height: 900 });
  await openAgentRoute(page, {
    workspaceId: scenario.workspace.workspaceId,
    agentId: scenario.agentId,
  });
  const tab = page.getByTestId(`workspace-tab-server_browser_${browserId}`);
  await expect(tab).toBeVisible({ timeout: 60_000 });
  // A tab in the background has no viewer, so opening the workspace leaves it suspended.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect(await scenario.tabInfo(browserId)).toMatchObject({ suspended: true });
  await tab.screenshot({ path: test.info().outputPath("suspended-tab.png") });
  await tab.click();

  const surface = page.getByTestId("server-browser-surface");
  await expect(surface.locator("img:visible, canvas:visible")).toHaveCount(1);
  await expect
    .poll(async () => (await scenario.tabInfo(browserId))?.suspended ?? false)
    .toBe(false);
  const reloaded = await scenario.tool("browser_evaluate", {
    browserId,
    function: "() => [location.pathname, window.scrollY]",
  });
  expect(reloaded).toMatchObject({ ok: true, result: { resultJson: '["/long",900]' } });
});
