import { useCallback } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { settingsStyles } from "@/styles/settings";
import { useServerBrowserStatus } from "./store";

export const SERVER_BROWSER_TITLE = "Server-side browser (experimental)";
export const SERVER_BROWSER_HINT =
  "Agents' browser tabs run in a headless Chromium on this host instead of in an app, so they keep working with every app closed and you can watch and take over from desktop or phone. Turning this on also turns on browser tools.";

/** On also enables browser tools: the server browser only serves agents through them. */
export function createServerBrowserPatch(enabled: boolean): Partial<MutableDaemonConfig> {
  return enabled
    ? { serverBrowser: { enabled: true }, browserTools: { enabled: true } }
    : { serverBrowser: { enabled: false } };
}

export function ServerBrowserSettingsRow({ serverId }: { serverId: string }) {
  const supported = useHostFeature(serverId, "serverBrowser");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const status = useServerBrowserStatus(serverId);
  const mutation = useMutation({
    mutationFn: async (next: boolean) => {
      const result = await patchConfig(createServerBrowserPatch(next));
      if (!result) throw new Error("The host is disconnected");
      return result;
    },
  });
  const handleValueChange = useCallback((next: boolean) => mutation.mutate(next), [mutation]);
  if (!supported) return null;
  const enabled = config?.serverBrowser?.enabled === true;
  const error = mutation.error instanceof Error ? mutation.error.message : null;

  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{SERVER_BROWSER_TITLE}</Text>
        <Text style={settingsStyles.rowHint}>{SERVER_BROWSER_HINT}</Text>
        {enabled && status?.unavailableReason ? (
          <Text style={settingsStyles.rowError}>{status.unavailableReason}</Text>
        ) : null}
        {error ? <Text style={settingsStyles.rowError}>{error}</Text> : null}
      </View>
      <Switch
        value={enabled}
        onValueChange={handleValueChange}
        disabled={mutation.isPending}
        accessibilityLabel="Enable the server-side browser"
        testID="host-page-server-browser-switch"
      />
    </View>
  );
}
