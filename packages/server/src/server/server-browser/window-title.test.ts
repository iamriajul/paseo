import { describe, expect, it } from "vitest";
import { stripSnapshotTitle, stripWindowTitle, windowTitleMark } from "./window-title.js";

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
