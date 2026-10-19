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
  try {
    await previewer.preview(input.data);
  } catch (error) {
    previewer.destroy();
    throw error;
  }
  return { destroy: () => previewer.destroy() };
}
