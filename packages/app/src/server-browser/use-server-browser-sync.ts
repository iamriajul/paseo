import { useEffect } from "react";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { stopForwardsOfEndedServerTabs } from "@/port-forward/server-tab-forwards";
import { reconcileHostTabs } from "./host-tabs";
import { useServerBrowserStore, type ServerBrowserTab } from "./store";

/**
 * Keeps one host's server browser tabs in the store, and every workspace's server tabs on this
 * client in line with the host's list (`host-tabs.ts`).
 */
export function useServerBrowserSync(serverId: string): void {
  const supported = useHostFeature(serverId, "serverBrowser");
  const keepsPins = useHostFeature(serverId, "serverBrowserTabPin");
  const client = useHostRuntimeClient(serverId);

  useEffect(() => {
    if (!supported || !client) return;
    const subscription = client.observeServerBrowserTabs();
    const apply = (tabs: ServerBrowserTab[], status: { enabled: boolean }, snapshot: boolean) => {
      useServerBrowserStore.getState().setHost(serverId, { tabs, status });
      reconcileHostTabs(serverId, tabs, { snapshot, keepsPins });
      stopForwardsOfEndedServerTabs(serverId, tabs);
    };
    const unsubscribe = subscription.subscribe({
      snapshot: (snapshot) => apply(snapshot.tabs, snapshot.status, true),
      update: (message) => {
        if (message.type === "browser.server.tabs.update") {
          apply(message.payload.tabs, message.payload.status, false);
        }
      },
    });
    return () => {
      unsubscribe();
      void subscription.release().catch(() => {});
      useServerBrowserStore.getState().clearHost(serverId);
    };
  }, [client, keepsPins, serverId, supported]);
}
