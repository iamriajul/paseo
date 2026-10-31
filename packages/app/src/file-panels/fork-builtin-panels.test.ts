import { describe, expect, it } from "vitest";
import { filePanelCatalog } from "./catalog";
import { resolveFilePanel } from "./resolve";

const builtins = filePanelCatalog([]);

function panelId(path: string): string | null {
  return (
    resolveFilePanel({ file: { path, kind: "binary" }, candidates: builtins, associations: {} })
      .panel?.id ?? null
  );
}

describe("fork built-in document panels", () => {
  it.each([
    ["docs/report.pdf", "builtin:pdf"],
    ["slides/deck.pptx", "builtin:office"],
    ["data/SHEET.XLSX", "builtin:office"],
    ["notes.docm", "builtin:office"],
    ["template.potx", "builtin:office"],
  ])("opens %s with %s", (path, id) => {
    expect(panelId(path)).toBe(id);
  });

  it("leaves legacy Word and PowerPoint files without a preview panel", () => {
    expect(panelId("old.doc")).toBeNull();
    expect(panelId("old.ppt")).toBeNull();
  });
});
