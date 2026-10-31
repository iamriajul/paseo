import { useEffect } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SessionEventSubscription } from "@getpaseo/protocol/messages";
import { useHostFeature } from "@/runtime/host-features";

/**
 * The fork's live pushes. A daemon delivers an unsolicited message to a modern client only when
 * that client subscribed to its event, so without this the handlers registered with `client.on`
 * never fire: drafts, reviews and todos stop following other devices, and background tasks and
 * provider heartbeats stop updating.
 */
export const FORK_SESSION_EVENTS = [
  "ui_state.updated",
  "workspace.todos.update",
  "agent.background_tasks.update",
  "agent.background_tasks.output.update",
  "agent.provider_heartbeats.update",
] as const satisfies readonly SessionEventSubscription[];

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
