import excelCss from "@js-preview/excel/lib/index.css";
import { openXlsxPreview } from "@/components/office-preview-xlsx.web";
import { startOfficePreviewWebView } from "@/components/office-preview-webview-bridge";

startOfficePreviewWebView({
  css: excelCss,
  open: (preview) => openXlsxPreview(preview),
});
