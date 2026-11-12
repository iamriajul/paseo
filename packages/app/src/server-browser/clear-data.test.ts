import { describe, expect, it, vi } from "vitest";
import { en } from "@/i18n/resources/en";
import type { ConfirmDialogInput } from "@/utils/confirm-dialog";
import { confirmAndClearServerBrowserData } from "./clear-data";

function translate(key: string): string {
  let value: unknown = en;
  for (const part of key.split(".")) value = (value as Record<string, unknown>)[part];
  if (typeof value !== "string") throw new Error(`missing string ${key}`);
  return value;
}

describe("confirmAndClearServerBrowserData", () => {
  it("asks first, saying it signs out of the workspace's dev apps, and clears only on yes", async () => {
    const asked: ConfirmDialogInput[] = [];
    const clear = vi.fn(async () => {});
    const declined = await confirmAndClearServerBrowserData({
      confirm: async (dialog) => {
        asked.push(dialog);
        return false;
      },
      clear,
      t: translate,
    });
    expect(declined).toBe(false);
    expect(clear).not.toHaveBeenCalled();
    expect(asked[0]?.destructive).toBe(true);
    expect(asked[0]?.message).toMatch(/signs you out of every dev app in this workspace/);

    await confirmAndClearServerBrowserData({ confirm: async () => true, clear, t: translate });
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
