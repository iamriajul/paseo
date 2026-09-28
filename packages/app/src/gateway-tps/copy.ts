// User-facing copy for the CLIProxyAPI throughput section in the context-meter
// tooltip, centralized the way gateway-quota/copy.ts is.
export const gatewayTpsCopy = {
  title: "CLIProxyAPI latest request",
  rate: (tps: number) => `${formatRate(tps)} tokens/sec`,
  // What the rate was measured over, so a stale figure reads as stale.
  detail: (outputTokens: number, generationMs: number) =>
    `${outputTokens} output tokens in ${formatSeconds(generationMs)} of generation`,
} as const;

function formatRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

function formatSeconds(generationMs: number): string {
  return generationMs >= 10_000
    ? `${(generationMs / 1000).toFixed(0)}s`
    : `${(generationMs / 1000).toFixed(1)}s`;
}
