import type { TFunction } from "i18next";
import type { UsageProblem } from "@getpaseo/protocol/messages";
import { i18n } from "@/i18n/i18next";
import { formatAgo } from "./format";

// Messages for usage failures outside the UI. Rendered copy uses useTranslation.
export const usageCopy = {
  problem: (problem: UsageProblem, now: Date = new Date(), t: TFunction = i18n.t): string => {
    if (problem.kind === "no_quota") return problem.detail;
    const remedy = problem.refreshedBy
      ? t("providerUsage.runToRefresh", { command: problem.refreshedBy })
      : t("providerUsage.signInAgain");
    if (problem.kind === "rejected")
      return t("providerUsage.loginRejected", { status: problem.status, remedy });
    return t("providerUsage.loginExpired", {
      relativeTime: formatAgo(problem.expiresAt, now.getTime(), t),
      remedy,
    });
  },
  get clientUnavailable() {
    return i18n.t("providerUsage.clientUnavailable");
  },
  // Fork Codex quota reset; plain English until the fork adds these to the i18n resources.
  resetQuota: "Reset quota",
  cancel: "Cancel",
  resetQuotaConfirmTitle: "Reset Codex quota?",
  resetQuotaConfirmMessage:
    "This consumes one available reset and immediately resets eligible Codex usage windows.",
  resetQuotaSuccessTitle: "Quota reset",
  resetQuotaNoopTitle: "No reset applied",
  resetQuotaFailedTitle: "Unable to reset quota",
} as const;
