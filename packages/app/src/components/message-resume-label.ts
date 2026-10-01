import { i18n } from "@/i18n/i18next";

export interface ResumeMarkerLabelInput {
  reason: "power_cut" | "manual";
}

export function getResumeMarkerLabel({ reason }: ResumeMarkerLabelInput): string {
  if (reason === "power_cut") return i18n.t("message.resume.poweredOff");
  return i18n.t("message.resume.manual");
}
