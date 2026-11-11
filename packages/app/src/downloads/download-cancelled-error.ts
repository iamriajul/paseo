import { i18n } from "@/i18n/i18next";

/** The user stopped the download, from the toast or the browser's download manager. */
export class DownloadCancelledError extends Error {
  constructor() {
    super(i18n.t("downloads.cancelled"));
    this.name = "DownloadCancelledError";
  }
}
