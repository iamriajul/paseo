import type { Browser, BrowserContext } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute } from "../support/helpers/mock-agent";
import {
  SERVER_BROWSER_DAEMON_CONFIG,
  startServerBrowserScenario,
  type ServerBrowserScenario,
} from "../support/helpers/server-browser";

test.use({ e2eInjectPaseoTools: true, e2eDaemonConfig: SERVER_BROWSER_DAEMON_CONFIG });

// The app's install id: a second device must have its own, or the daemon sees one client.
const CLIENT_ID_KEY = "@paseo:client-id-v1";
const ICON_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'><rect width='1' height='1' fill='red'/></svg>";

let scenario: ServerBrowserScenario;
let otherDevice: BrowserContext | null = null;

test.beforeEach(async () => {
  scenario = await startServerBrowserScenario({
    "/icon-page": "<title>Icon page</title><link rel=icon href=/icon.svg><p>icon</p>",
    "/icon.svg": ICON_SVG,
  });
});

test.afterEach(async () => {
  await otherDevice?.close();
  otherDevice = null;
  await scenario.close();
});

async function openScenarioWorkspace(page: Page): Promise<void> {
  await openAgentRoute(page, {
    workspaceId: scenario.workspace.workspaceId,
    agentId: scenario.agentId,
  });
  await expect(page.getByTestId(`workspace-tab-agent_${scenario.agentId}`)).toBeVisible({
    timeout: 60_000,
  });
}

/** A second app install against the same daemon: its own storage, layout and client id. */
async function openOtherDevice(
  browser: Browser,
  from: Page,
  baseURL: string | undefined,
): Promise<Page> {
  const state = await from.context().storageState();
  for (const origin of state.origins) {
    origin.localStorage = origin.localStorage.filter((item) => item.name !== CLIENT_ID_KEY);
  }
  otherDevice = await browser.newContext({ storageState: state, baseURL });
  const page = await otherDevice.newPage();
  await page.route(/:(6767)\b/, (route) => route.abort());
  await page.setViewportSize({ width: 1400, height: 900 });
  await openScenarioWorkspace(page);
  return page;
}

test("server tabs are the same on every device: opened, navigated, iconed and closed", async ({
  page,
  browser,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openScenarioWorkspace(page);
  const phone = await openOtherDevice(browser, page, baseURL);

  // A tab the user opens on this device, from the new-tab menu.
  await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).click();
  await page
    .getByTestId("workspace-new-tab-menu")
    .filter({ visible: true })
    .getByText("Server browser", { exact: true })
    .click();
  await expect.poll(async () => (await scenario.listTabIds()).length).toBe(1);
  const [browserId] = await scenario.listTabIds();
  const onOther = phone.getByTestId(`workspace-tab-server_browser_${browserId}`);
  await expect(onOther).toBeVisible();

  // Navigation, title and icon reach the other device.
  const url = page.getByLabel("Server browser URL").locator("visible=true");
  await url.fill(`${scenario.siteUrl}/icon-page`);
  await url.press("Enter");
  await expect(onOther).toContainText("Icon page");
  await expect(onOther.getByTestId("server-browser-tab-favicon")).toBeVisible();
  // The opener shows the tab once, though the host listed it before answering with its id.
  const here = page.locator('[data-testid^="workspace-tab-"]').filter({ hasText: "Icon page" });
  await expect(here).toHaveCount(1);
  await expect(here.getByTestId("server-browser-tab-favicon")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("opener.png") });
  await phone.screenshot({ path: test.info().outputPath("other-device.png") });

  // An agent's tab shows on both.
  const agentTab = await scenario.newTab("/");
  await expect(page.getByTestId(`workspace-tab-server_browser_${agentTab}`)).toBeVisible();
  await expect(phone.getByTestId(`workspace-tab-server_browser_${agentTab}`)).toBeVisible();

  // Closing it on the other device closes it here and on the host.
  await onOther.hover();
  await phone.getByTestId(`workspace-server-browser-close-${browserId}`).click();
  await expect(onOther).toHaveCount(0);
  await expect(here).toHaveCount(0);
  await expect.poll(() => scenario.listTabIds()).not.toContain(browserId);
});
