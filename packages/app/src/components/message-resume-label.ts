import { i18n } from "@/i18n/i18next";

export interface ResumeMarkerLabelInput {
  reason: string;
  prompt: string;
}

// The recovery marker shows the prompt that was sent, so it keeps its text after the
// configured prompt changes. The rate-limit marker keeps its fixed label.
export function getResumeMarkerLabel({ reason, prompt }: ResumeMarkerLabelInput): string {
  if (reason === "rate_limit_retry") return i18n.t("message.resume.rateLimitCooldown");
  return i18n.t("message.resume.recovery", { prompt });
}
