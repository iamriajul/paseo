export const CLIENT_SHUTDOWN_RPC_REASON = "client_shutdown_rpc";
export const DEFAULT_CLIENT_RESTART_RPC_REASON = "client_restart_rpc";

export function normalizeClientRestartRpcReason(reason: string | undefined): string {
  return reason?.trim() || DEFAULT_CLIENT_RESTART_RPC_REASON;
}

// Stops the software makes for itself. A daemon stopped this way resumes its agents on the next
// start; a stop a person asked for does not.
const AUTOMATIC_DAEMON_STOP_REASONS: ReadonlySet<string> = new Set([
  "app_update",
  "version_mismatch",
]);

export function isAutomaticDaemonStopReason(reason: string | undefined): boolean {
  return reason !== undefined && AUTOMATIC_DAEMON_STOP_REASONS.has(reason);
}
