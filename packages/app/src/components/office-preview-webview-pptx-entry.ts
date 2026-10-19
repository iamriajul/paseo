import { openPptxPreview } from "@/components/office-preview-pptx.web";
import { startOfficePreviewWebView } from "@/components/office-preview-webview-bridge";

startOfficePreviewWebView({
  css: "",
  open: (preview) => openPptxPreview(preview),
});
