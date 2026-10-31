import { useEffect } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { FORK_SESSION_EVENTS } from "@getpaseo/protocol/messages";
import { useHostFeature } from "@/runtime/host-features";

/**
 * Subscribes to the fork's live pushes (`FORK_SESSION_EVENTS` in protocol). Without it the
 * handlers registered with `client.on` never fire: drafts, reviews and todos stop following other
 * devices, and background tasks and provider heartbeats stop updating.
 */
export function useForkSessionEvents(client: DaemonClient | null, serverId: string): void {
  const supported = useHostFeature(serverId, "forkSessionEvents");
  useEffect(() => {
    if (!client || !supported) return;
    const subscription = client.observeEvents([...FORK_SESSION_EVENTS]);
    return () => {
      void subscription.release().catch(() => undefined);
    };
  }, [client, supported]);
}
