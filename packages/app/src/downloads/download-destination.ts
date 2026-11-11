import { FileMode } from "expo-file-system";
import { resolveDownloadTargetFile } from "@/downloads/save-file";
import type {
  DownloadDestination,
  DownloadSink,
  DownloadTarget,
  PrepareDownloadDestination,
} from "@/downloads/download-destination.types";

export type {
  DownloadDestination,
  DownloadSink,
  DownloadTarget,
  PrepareDownloadDestination,
} from "@/downloads/download-destination.types";

/**
 * iOS and Android write each slice to a file in the app's cache through one open handle, then
 * hand the finished file to the share sheet as before. A failed or cancelled download deletes
 * the partial file.
 */
export const prepareDownloadDestination: PrepareDownloadDestination = async () => destination;

const destination: DownloadDestination = {
  begin: async (target) => openFileSink(target),
  discard: async () => undefined,
};

function openFileSink(target: DownloadTarget): DownloadSink {
  // Resolve and create in one tick so two downloads of the same name cannot pick the same path.
  const file = resolveDownloadTargetFile(target.fileName);
  file.create();
  const handle = file.open(FileMode.WriteOnly);
  let open = true;
  function release() {
    if (!open) return;
    open = false;
    handle.close();
  }
  return {
    write: async (chunk) => {
      handle.writeBytes(chunk);
    },
    close: async () => {
      release();
      return file.uri;
    },
    abort: async () => {
      release();
      if (file.exists) file.delete();
    },
  };
}
