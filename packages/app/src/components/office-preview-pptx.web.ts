// pptx-preview paints its wrapper black, so the pane showed a black band under the last slide,
// and a deck it parses to no slides showed as a black box instead of the failed state. The
// inline wrapper colour needs !important to override.
const PPTX_PREVIEW_CSS = ".pptx-preview-wrapper { background: transparent !important; }";

export async function openPptxPreview(input: {
  host: HTMLElement;
  data: ArrayBuffer;
  width: number;
  height: number;
}): Promise<{ destroy: () => void }> {
  const { init } = await import("pptx-preview");
  const width = Math.max(input.width, 320);
  const previewer = init(input.host, {
    width,
    height: Math.max(Math.round(input.height), 1),
    mode: "list",
  });
  const style = document.createElement("style");
  style.textContent = PPTX_PREVIEW_CSS;
  input.host.prepend(style);
  const destroy = () => {
    previewer.destroy();
    style.remove();
  };
  try {
    await previewer.preview(input.data);
    if (previewer.slideCount === 0) {
      throw new Error("pptx-preview parsed no slides");
    }
  } catch (error) {
    destroy();
    throw error;
  }
  return { destroy };
}
