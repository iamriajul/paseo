import type { ConfirmDialogInput } from "@/utils/confirm-dialog";

/**
 * Clear browser data, after the user confirms it: it deletes the workspace's cookies and storage
 * in the server browser, which signs them out of every dev app the workspace runs.
 */
export async function confirmAndClearServerBrowserData(input: {
  confirm: (dialog: ConfirmDialogInput) => Promise<boolean>;
  clear: () => Promise<void>;
  t: (key: string) => string;
}): Promise<boolean> {
  const confirmed = await input.confirm({
    title: input.t("workspace.browser.serverTab.clearDataTitle"),
    message: input.t("workspace.browser.serverTab.clearDataMessage"),
    confirmLabel: input.t("workspace.browser.serverTab.clearData"),
    cancelLabel: input.t("common.actions.cancel"),
    destructive: true,
  });
  if (!confirmed) return false;
  await input.clear();
  return true;
}
