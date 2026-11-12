import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useToast } from "@/contexts/toast-api-context";
import { useHostFeature } from "@/runtime/host-features";
import { copyElementScreenshot } from "./copy-element-screenshot";

/**
 * Copies the page's selection to this device's clipboard: Cmd/Ctrl+C in the viewer, or the
 * actions menu on a phone. The page runs on the host, so its own copy lands on the host's
 * clipboard; this reads the selection and writes it here. Undefined on hosts without it.
 */
export function useCopySelection(input: {
  client: DaemonClient | null;
  serverId: string;
  browserId: string;
}): (() => void) | undefined {
  const { client, browserId } = input;
  const { t } = useTranslation();
  const toast = useToast();
  const supported = useHostFeature(input.serverId, "serverBrowserClipboard");
  const copy = useCallback(() => {
    if (!client) return;
    void (async () => {
      const text = await client.serverBrowserSelection(browserId);
      if (!text) {
        toast.show(t("workspace.browser.serverTab.nothingSelected"), { variant: "info" });
        return;
      }
      await copyElementScreenshot({ pngBase64: undefined, text });
      toast.show(t("workspace.browser.serverTab.selectionCopied"), { variant: "success" });
    })().catch((error: unknown) => {
      toast.show(error instanceof Error ? error.message : String(error), { variant: "error" });
    });
  }, [browserId, client, t, toast]);
  return supported ? copy : undefined;
}
