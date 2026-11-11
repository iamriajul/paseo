import type express from "express";
import type pino from "pino";
import { formatAttachmentContentDisposition } from "./content-disposition.js";
import { createFolderZipStream, FOLDER_ZIP_MIME_TYPE } from "./folder-zip.js";
import type { DownloadTokenEntry } from "./token-store.js";

/**
 * Answers /api/files/download for a folder token. The zip's length is unknown until the walk
 * ends, so the response is chunked. Once bytes are on the wire a failure can only cut the
 * response short; the truncated zip fails to open rather than passing for complete.
 */
export function streamFolderZipDownload({
  entry,
  res,
  logger,
}: {
  entry: Extract<DownloadTokenEntry, { kind: "folder" }>;
  res: express.Response;
  logger: pino.Logger;
}): void {
  const abort = new AbortController();
  const zip = createFolderZipStream(entry, { signal: abort.signal });
  res.once("close", () => {
    abort.abort();
    zip.destroy();
  });
  zip.once("error", (err) => {
    logger.error({ err, path: entry.path }, "Failed to stream folder download");
    if (!res.headersSent) {
      res.removeHeader("Content-Type");
      res.removeHeader("Content-Disposition");
      // The walk fails with FolderZipErrors, which name the entry and the reason.
      res.status(500).json({ error: err.message });
    } else {
      res.destroy(err);
    }
  });
  res.setHeader("Content-Type", FOLDER_ZIP_MIME_TYPE);
  res.setHeader("Content-Disposition", formatAttachmentContentDisposition(entry.fileName));
  zip.pipe(res);
}
