import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { openNewWorkspaceComposer } from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

// Until the draft's model resolves there is no provider to create with. Create used to stay
// enabled through that window, and a press in it failed with "Select a model" while the picker
// was about to show one.
test("Create waits for the draft's model before it can be pressed", async ({ page }) => {
  let holding = true;
  const held: Array<{ send: (message: string) => void; message: string }> = [];
  let createRequests = 0;
  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (typeof message === "string" && message.includes('"workspace.create.request"')) {
        createRequests += 1;
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const isSnapshot =
        typeof message === "string" && message.includes('"get_providers_snapshot_response"');
      if (isSnapshot && holding) held.push({ send: (frame) => ws.send(frame), message });
      else ws.send(message);
    });
  });
  const seeded = await seedWorkspace({ repoPrefix: "new-workspace-create-waits-" });
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, seeded);

    const composer = page.getByRole("textbox", { name: "Message agent..." });
    await expect(composer).toBeEditable({ timeout: 30_000 });
    await composer.fill("Create once the model is known");
    const create = page.getByTestId("message-input-root").getByRole("button", { name: "Create" });
    await expect(create).toBeDisabled();
    await composer.press("Enter");
    await expect(page.getByText("Select a model", { exact: true })).toHaveCount(0);
    expect(createRequests).toBe(0);

    holding = false;
    for (const frame of held.splice(0)) frame.send(frame.message);
    await expect(create).toBeEnabled({ timeout: 30_000 });
    await create.click();
    await expect.poll(() => createRequests, { timeout: 30_000 }).toBe(1);
    await expect(page.getByText("Select a model", { exact: true })).toHaveCount(0);
    // Landing in the workspace consumes the draft; leaving earlier would hand its text to the
    // next New workspace screen on this daemon.
    await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
    await expect(page.getByTestId("user-message").first()).toBeVisible({ timeout: 30_000 });
  } finally {
    holding = false;
    for (const frame of held.splice(0)) frame.send(frame.message);
    await seeded.cleanup();
  }
});
