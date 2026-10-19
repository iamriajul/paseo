import docxCss from "@js-preview/docx/lib/index.css";
import { openDocxPreview } from "@/components/office-preview-docx.web";
import { startOfficePreviewWebView } from "@/components/office-preview-webview-bridge";

startOfficePreviewWebView({
  css: docxCss,
  open: (preview) => openDocxPreview(preview),
});
