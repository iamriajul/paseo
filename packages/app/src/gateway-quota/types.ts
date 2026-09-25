import type {
  GatewayQuotaAccount,
  GatewayQuotaGetResponseMessage,
  GatewayQuotaWindow,
} from "@getpaseo/protocol/messages";

export type { GatewayQuotaAccount, GatewayQuotaWindow };

export type GatewayQuotaPayload = GatewayQuotaGetResponseMessage["payload"];

export type GatewayQuotaView =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; payload: GatewayQuotaPayload };
