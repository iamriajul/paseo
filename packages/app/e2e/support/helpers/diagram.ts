import { expect, type Page } from "@playwright/test";
import type { MockAgentWorkspace } from "./mock-agent";

const DIAGRAM_NAME = "Diagram";

function renderedDiagram(page: Page) {
  const diagram = page.getByRole("img", { name: DIAGRAM_NAME }).last();
  const svg = diagram.locator("iframe").contentFrame().locator("#diagram svg");
  return { diagram, svg };
}

export async function requestDiagram(agent: MockAgentWorkspace): Promise<void> {
  await agent.client.sendAgentMessage(agent.agentId, "Render the requested Mermaid diagram.");
}

export async function expectDiagramWithLabels(
  page: Page,
  labels: readonly string[],
): Promise<void> {
  const { diagram, svg } = renderedDiagram(page);
  await expect(diagram).toBeVisible({ timeout: 30_000 });
  await expect(svg).toBeVisible({ timeout: 30_000 });
  for (const label of labels) {
    await expect(svg).toContainText(label);
  }
}

const STREAMING_OBSERVATION_MS = 3_000;

// Continuity is watched from inside the sandboxed runtime frame rather than by polling
// it from the driver. Re-resolving a locator through an opaque-origin `srcdoc` iframe
// costs ~230ms on an idle machine and over 500ms on a loaded CI runner, so a poll loop
// measures how fast Playwright can reach the frame, not whether the diagram stayed up:
// it fails while the SVG is provably present, and a real removal that is restored within
// one poll budget slips through unnoticed. A MutationObserver on #diagram sees every
// commit the runtime makes and is unaffected by driver latency.
export async function expectDiagramRemainsRenderedWhileStreaming(page: Page): Promise<void> {
  const { diagram, svg } = renderedDiagram(page);
  await expect(diagram).toBeVisible({ timeout: 30_000 });
  await expect(svg).toBeVisible({ timeout: 30_000 });

  const host = diagram.locator("iframe").contentFrame().locator("#diagram");
  await host.evaluate((element) => {
    const state = { emptied: 0 };
    (window as unknown as Record<string, unknown>).__paseoDiagramContinuity = state;
    new MutationObserver(() => {
      if (!element.querySelector("svg")) state.emptied += 1;
    }).observe(element, { childList: true, subtree: true });
  });

  await page.waitForTimeout(STREAMING_OBSERVATION_MS);

  const emptied = await host.evaluate(() => {
    const state = (window as unknown as Record<string, { emptied: number } | undefined>)
      .__paseoDiagramContinuity;
    // A missing observer means the runtime frame was torn down and remounted mid-stream,
    // which loses the rendered diagram just as visibly as emptying #diagram does.
    return state ? state.emptied : -1;
  });
  expect(emptied, "#diagram lost its committed SVG while the message was still streaming").toBe(0);

  await expect(diagram).toBeVisible();
  await expect(svg).toBeVisible();
}

export async function waitForDiagramTurnToComplete(agent: MockAgentWorkspace): Promise<void> {
  await agent.client.waitForFinish(agent.agentId, 30_000);
}

export async function expectCompletedDiagram(page: Page, labels: readonly string[]): Promise<void> {
  await expectDiagramWithLabels(page, labels);
}

export async function reloadConversation(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
}
