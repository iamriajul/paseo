/**
 * Cents above a cent; a tenth of a cent below it, because a Haiku turn or warm-up costs a fraction
 * of a cent and "<$0.01" on every one of them says nothing.
 */
export function formatUsdEstimate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value < 0.001) return "<$0.001";
  if (value < 0.01) return `$${value.toFixed(3)}`;
  if (value < 100) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/**
 * Claude Code's own session cost, plus what Paseo's fork warm-ups cost. A fork warm-up runs
 * in a throwaway fork whose cost Claude Code never adds to the session's total; a ping warm-up is a
 * turn of the session, so Claude Code already counts it.
 */
export function resolveSessionCostUsd(
  agent: { lastUsage?: { totalCostUsd?: number }; warmUpCostUsd?: number } | null | undefined,
): number | null {
  const reported = agent?.lastUsage?.totalCostUsd;
  const warmUps = agent?.warmUpCostUsd;
  if (reported === undefined && warmUps === undefined) return null;
  return (reported ?? 0) + (warmUps ?? 0);
}
