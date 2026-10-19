export async function openXlsxPreview(input: {
  host: HTMLElement;
  data: ArrayBuffer;
}): Promise<{ destroy: () => void }> {
  const [{ default: jsPreviewExcel }] = await Promise.all([
    import("@js-preview/excel"),
    import("@js-preview/excel/lib/index.css"),
  ]);
  const previewer = jsPreviewExcel.init(input.host, {
    minColLength: 0,
    showContextmenu: false,
  });
  try {
    await previewer.preview(input.data);
  } catch (error) {
    previewer.destroy();
    throw error;
  }
  return { destroy: () => previewer.destroy() };
}
