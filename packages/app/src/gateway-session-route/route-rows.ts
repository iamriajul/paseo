import type { GatewaySessionRoute } from "@getpaseo/protocol/messages";
import { formatAgo } from "@/usage/format";

export const gatewaySessionRouteCopy = {
  servedBy: "Served by",
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
