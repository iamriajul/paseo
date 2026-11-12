import { describe, expect, it } from "vitest";
import { editingModifiers } from "./server-browser-tab.js";

describe("editingModifiers", () => {
  it("turns a Mac viewer's Cmd editing keys into Ctrl on a host that is not a Mac", () => {
    expect(editingModifiers({ code: "KeyA", modifiers: ["Meta"] }, "linux")).toEqual(["Control"]);
    expect(editingModifiers({ code: "KeyZ", modifiers: ["Meta", "Shift"] }, "win32")).toEqual([
      "Control",
      "Shift",
    ]);
  });

  it("leaves other keys, other modifiers and a Mac host alone", () => {
    expect(editingModifiers({ code: "KeyA", modifiers: ["Meta"] }, "darwin")).toEqual(["Meta"]);
    expect(editingModifiers({ code: "KeyT", modifiers: ["Meta"] }, "linux")).toEqual(["Meta"]);
    expect(editingModifiers({ code: "KeyA", modifiers: ["Meta", "Alt"] }, "linux")).toEqual([
      "Meta",
      "Alt",
    ]);
    expect(editingModifiers({ code: "KeyA", modifiers: ["Control"] }, "linux")).toEqual([
      "Control",
    ]);
    expect(editingModifiers({ code: "KeyA" }, "linux")).toBeUndefined();
  });
});
