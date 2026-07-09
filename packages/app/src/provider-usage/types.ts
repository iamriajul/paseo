import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageDetail,
  ProviderUsageListResponseMessage,
  ProviderUsageResetCredit,
  ProviderUsageResetQuotaResponseMessage,
  ProviderUsageStatus,
  ProviderUsageTone,
  ProviderUsageWindow,
} from "@getpaseo/protocol/messages";

export type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageDetail,
  ProviderUsageResetCredit,
  ProviderUsageStatus,
  ProviderUsageTone,
  ProviderUsageWindow,
};

export type ProviderUsageBalanceUnit = ProviderUsageBalance["unit"];
export type ProviderUsageListPayload = ProviderUsageListResponseMessage["payload"];
export type ProviderUsageResetQuotaPayload = ProviderUsageResetQuotaResponseMessage["payload"];

export type ProviderUsageView =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; payload: ProviderUsageListPayload; isRefreshing: boolean };
