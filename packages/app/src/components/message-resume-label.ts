import { i18n } from "@/i18n/i18next";

export interface ResumeMarkerLabelInput {
  reason: "power_cut" | "manual" | "rate_limit_retry";
}

export function getResumeMarkerLabel({ reason }: ResumeMarkerLabelInput): string {
  if (reason === "power_cut") return i18n.t("message.resume.poweredOff");
  if (reason === "rate_limit_retry") return i18n.t("message.resume.rateLimitCooldown");
  return i18n.t("message.resume.manual");
}
