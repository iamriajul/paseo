import type { GatewayAccountChange } from "@getpaseo/protocol/agent-cache-warm";
import type { GatewaySessionRoute } from "@getpaseo/protocol/messages";
import { formatAgo } from "@/usage/format";

export const gatewaySessionRouteCopy = {
  servedBy: "Served by",
  lastServedBy: "Last served by",
  since: "Since",
  coolingDown: "cooling down",
  switched: "Switched",
} as const;

export interface SessionRouteRow {
  label: string;
  value: string;
}

/**
 * "Served by" always, then the newest switch when there is one, so a reader
 * who sees an unfamiliar account also sees when and why the session moved.
 */
export function buildSessionRouteRows(route: GatewaySessionRoute): SessionRouteRow[] {
  const account = [route.account.label, route.account.plan].filter(Boolean).join(" · ");
  const rows: SessionRouteRow[] = [
    {
      label: gatewaySessionRouteCopy.servedBy,
      value: route.account.inCooldown
        ? `${account} (${gatewaySessionRouteCopy.coolingDown})`
        : account,
    },
  ];
  // The account it left is in the All accounts window and in the timeline notice,
  // so the row carries only when and why: a narrow sheet cannot fit two labels.
  const latest = route.switches.at(-1);
  if (latest) {
    const ago = formatAgo(latest.at);
    rows.push({
      label: gatewaySessionRouteCopy.switched,
      value: ago ? `${ago} (${latest.reason})` : latest.reason,
    });
  }
  return rows;
}

/**
 * The account Paseo last saw serving the session, for when the Gateway has no live route for it.
 * The Gateway keeps routes in memory only: a restart or upgrade, an hour without a request, or
 * eviction drops them, while the agent's own record keeps the account. A Codex session idles
 * past the hour often, since nothing warms it. It says since when, because the next request may go to
 * another account.
 */
export function buildLastServedRows(change: GatewayAccountChange): SessionRouteRow[] {
  const account = [change.account, change.plan].filter(Boolean).join(" · ");
  const rows: SessionRouteRow[] = [{ label: gatewaySessionRouteCopy.lastServedBy, value: account }];
  // Its own row: on one line with a long account label the age was cut off.
  const ago = formatAgo(change.at);
  if (ago) rows.push({ label: gatewaySessionRouteCopy.since, value: ago });
  return rows;
}
