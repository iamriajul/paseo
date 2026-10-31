/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

const previewer = vi.hoisted(() => ({ slideCount: 1, destroyed: 0 }));

vi.mock("pptx-preview", () => ({
  init: (host: HTMLElement) => {
    const wrapper = document.createElement("div");
    wrapper.className = "pptx-preview-wrapper";
    wrapper.style.setProperty("background", "#000");
    host.append(wrapper);
    return {
      get slideCount() {
        return previewer.slideCount;
      },
      preview: async () => undefined,
      destroy: () => {
        previewer.destroyed += 1;
        wrapper.remove();
      },
    };
  },
}));

const { openPptxPreview } = await import("./office-preview-pptx.web");

function open(host: HTMLElement) {
  return openPptxPreview({ host, data: new ArrayBuffer(0), width: 400, height: 300 });
}

afterEach(() => {
  previewer.slideCount = 1;
  previewer.destroyed = 0;
  document.body.innerHTML = "";
});

describe("openPptxPreview", () => {
  it("clears the library's black wrapper so no black band shows under the slides", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    await open(host);

    expect(host.querySelector("style")?.textContent).toContain(
      ".pptx-preview-wrapper { background: transparent !important; }",
    );
  });

  it("fails a deck the library parses to no slides instead of showing an empty box", async () => {
    previewer.slideCount = 0;
    const host = document.createElement("div");
    document.body.append(host);

    await expect(open(host)).rejects.toThrow("parsed no slides");
    expect(previewer.destroyed).toBe(1);
    expect(host.innerHTML).toBe("");
  });
});
