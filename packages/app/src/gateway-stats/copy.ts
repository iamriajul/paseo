// User-facing copy and formatting for the CLIProxyAPI last-request section in
// the context-meter tooltip, centralized the way gateway-quota/copy.ts is.
export const gatewayStatsCopy = {
  title: "CLIProxyAPI latest request",
  firstToken: "First token",
  generating: "Generating",
  total: "Total",
  throughput: "Throughput",
  ran: "Ran",
} as const;

/** Seconds, one decimal below 10s and whole above it. */
export function formatSeconds(generationMs: number): string {
  if (!Number.isFinite(generationMs) || generationMs <= 0) return "0s";
  const seconds = generationMs / 1000;
  return seconds >= 10 ? `${seconds.toFixed(0)}s` : `${seconds.toFixed(1)}s`;
}

export function formatThroughput(tps: number): string {
  if (!Number.isFinite(tps) || tps <= 0) return "0 tok/s";
  return `${tps >= 100 ? tps.toFixed(0) : tps.toFixed(1)} tok/s`;
}
