// A pinned tab in the real Electron shell: Ctrl/Cmd+W (the desktop-only binding), middle-click
// and an agent's browser_close_tab all leave it, and it closes once unpinned.

import { setTimeout as delay } from "node:timers/promises";

const TIMEOUT_MS = 30_000;
// Long enough for a close to land if it was going to.
const SETTLE_MS = 750;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function runPinnedTabsRegression({ page, client, serverId, workspaceId, targetUrl }) {
  const workspaceRow = page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceId}`);
  await workspaceRow.waitFor({ state: "visible", timeout: TIMEOUT_MS });
  await workspaceRow.click();

  const created = await client.callTool({ name: "browser_new_tab", args: { url: targetUrl } });
  const browserId = created.structuredContent?.result?.browserId;
  assert(typeof browserId === "string", `browser_new_tab failed: ${JSON.stringify(created)}`);

  const deck = page.getByTestId(`workspace-deck-entry-${serverId}:${workspaceId}`);
  const chip = deck.getByTestId(`workspace-tab-browser_${browserId}`);
  const menu = `workspace-tab-context-browser_${browserId}`;
  const closeShortcut = process.platform === "darwin" ? "Meta+w" : "Control+w";
  const expectOpen = async (label) => {
    await delay(SETTLE_MS);
    assert((await chip.count()) === 1, `${label} closed the pinned tab`);
  };

  await chip.click({ button: "right" });
  await page.getByTestId(`${menu}-pin`).click();
  await chip.getByTestId("workspace-tab-pinned-indicator").waitFor({ timeout: TIMEOUT_MS });

  await chip.click({ button: "middle" });
  await expectOpen("Middle-click");

  await chip.click();
  await page.keyboard.press(closeShortcut);
  await expectOpen(closeShortcut);

  const refused = await client.callTool({ name: "browser_close_tab", args: { browserId } });
  const refusal = refused.structuredContent;
  assert(
    refusal?.ok === false &&
      refusal.error?.code === "browser_denied" &&
      /user pinned this tab/.test(refusal.error?.message ?? ""),
    `browser_close_tab on a pinned tab was not refused: ${JSON.stringify(refused)}`,
  );
  await expectOpen("browser_close_tab");

  await chip.click({ button: "right" });
  await page.getByTestId(`${menu}-unpin`).click();
  await chip.click();
  await page.keyboard.press(closeShortcut);
  await chip.waitFor({ state: "detached", timeout: TIMEOUT_MS });

  return { browserId, closeShortcut };
}
