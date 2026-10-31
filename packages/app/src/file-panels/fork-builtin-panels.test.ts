import { describe, expect, it } from "vitest";
import { filePanelCatalog } from "./catalog";
import { resolveFilePanel } from "./resolve";
import { buildFilePanelSettingsRows } from "./settings/rows";

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

  it("yields to a plugin panel that claims the file, without asking", () => {
    const plugin = { id: "plugin:pdf/viewer", builtin: false, files: { extensions: ["pdf"] } };
    const resolution = resolveFilePanel({
      file: { path: "docs/report.pdf", kind: "binary" },
      candidates: filePanelCatalog([plugin]),
      associations: {},
    });
    expect(resolution.panel?.id).toBe("plugin:pdf/viewer");
    expect(resolution.candidates.map(({ id }) => id)).toEqual(["plugin:pdf/viewer"]);
  });

  it("is never offered as a choice in Settings > Files", () => {
    const rows = buildFilePanelSettingsRows({
      candidates: builtins,
      associations: { "ext:pdf": "plugin:none/none" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].candidates.map(({ id }) => id)).toEqual(["builtin:source"]);
  });

  it("leaves legacy Word and PowerPoint files without a preview panel", () => {
    expect(panelId("old.doc")).toBeNull();
    expect(panelId("old.ppt")).toBeNull();
  });
});
