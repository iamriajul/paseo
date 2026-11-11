import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  TITLE_BINDING,
  stripSnapshotTitle,
  stripWindowTitle,
  titleObserverScript,
  windowTitleMark,
} from "./window-title.js";

/** A page whose own code keeps its title, as an app's title observer does (Next.js workspaces). */
function pageThatKeepsItsTitle() {
  const dom = new JSDOM("<!doctype html><title>Loading | App</title>", {
    runScripts: "outside-only",
  });
  const { window } = dom;
  const reports: string[] = [];
  Object.assign(window, { [TITLE_BINDING]: (title: string) => reports.push(title) });
  const page = { own: "Loading | App", writes: 0 };
  // Stops itself after 10,000 writes, so a loop that never ends fails the test instead of hanging it.
  new window.MutationObserver(() => {
    if (window.document.title === page.own || page.writes >= 10_000) return;
    page.writes += 1;
    window.document.title = page.own;
  }).observe(window.document.querySelector("title")!, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  return { window, page, reports };
}

async function settle(window: JSDOM["window"]): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 50));
}

describe("title observer", () => {
  const mark = windowTitleMark("Fork work");

  it("stops marking a page that puts its own title back, instead of fighting it forever", async () => {
    const { window, page, reports } = pageThatKeepsItsTitle();
    window.eval(titleObserverScript(mark));
    page.own = "Settings | App";
    window.document.title = page.own;
    await settle(window);

    expect(page.writes).toBeLessThan(50);
    expect(window.document.title).toBe("Settings | App");
    expect(reports.at(-1)).toBe("Settings | App");
  });

  it("marks and reports the title of a page that leaves it alone", async () => {
    const dom = new JSDOM("<!doctype html><title>Inbox</title>", { runScripts: "outside-only" });
    const reports: string[] = [];
    Object.assign(dom.window, { [TITLE_BINDING]: (title: string) => reports.push(title) });
    dom.window.eval(titleObserverScript(mark));
    await settle(dom.window);
    dom.window.document.title = "(1) Inbox";
    await settle(dom.window);

    expect(dom.window.document.title).toBe("Paseo · Fork work · (1) Inbox");
    expect(reports).toEqual(["Paseo · Fork work · Inbox", "Paseo · Fork work · (1) Inbox"]);
  });
});

describe("window title mark", () => {
  const mark = windowTitleMark("  Fork   work ");

  it("names Paseo and the workspace, with whitespace collapsed as a snapshot does", () => {
    expect(mark).toEqual({ label: "Paseo · Fork work", prefix: "Paseo · Fork work · " });
    expect(windowTitleMark(null)).toEqual({ label: "Paseo", prefix: "Paseo · " });
  });

  it("gives back the page's own title, including one the page built from its marked title", () => {
    expect(stripWindowTitle("Paseo · Fork work · Inbox", mark)).toBe("Inbox");
    expect(stripWindowTitle("(1) Paseo · Fork work · Inbox", mark)).toBe("(1) Inbox");
    expect(stripWindowTitle("Paseo · Fork work", mark)).toBe("");
    expect(stripWindowTitle("Inbox", mark)).toBe("Inbox");
  });

  it("strips the mark from a snapshot's root line only", () => {
    const body = '\n  - heading "Paseo · Fork work · in the page" [level=1]';
    expect(stripSnapshotTitle(`- document "Paseo · Fork work · \\"Inbox\\""${body}`, mark)).toBe(
      `- document "\\"Inbox\\""${body}`,
    );
    expect(stripSnapshotTitle(`- document "Paseo · Fork work"${body}`, mark)).toBe(
      `- document${body}`,
    );
    expect(stripSnapshotTitle("- document", mark)).toBe("- document");
  });
});
