import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { settingsStyles } from "@/styles/settings";
import {
  createServerBrowserModePatch,
  resolveServerBrowserMode,
  SERVER_BROWSER_DEFAULT_CDP_URL,
  SERVER_BROWSER_MODES,
  type ServerBrowserMode,
} from "./engine-mode";
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
  const engines = useHostFeature(serverId, "serverBrowserEngines");
  return engines ? (
    <ServerBrowserEngineRow serverId={serverId} />
  ) : (
    <ServerBrowserSwitchRow serverId={serverId} />
  );
}

const MODE_OPTIONS: SelectFieldOption<ServerBrowserMode>[] = SERVER_BROWSER_MODES.map((entry) => ({
  id: entry.mode,
  value: entry.mode,
  label: entry.label,
  description: entry.description,
  testID: `host-page-server-browser-mode-${entry.mode}`,
}));

/** Off, or the engine agents' tabs run in, with what each one trades off. */
function ServerBrowserEngineRow({ serverId }: { serverId: string }) {
  const { config, patchConfig } = useDaemonConfig(serverId);
  const status = useServerBrowserStatus(serverId);
  const mode = resolveServerBrowserMode(config?.serverBrowser);
  const savedCdpUrl = config?.serverBrowser?.cdpUrl ?? "";
  const [cdpUrl, setCdpUrl] = useState(savedCdpUrl);
  const mutation = useMutation({
    mutationFn: async (patch: Partial<MutableDaemonConfig>) => {
      const result = await patchConfig(patch);
      if (!result) throw new Error("The host is disconnected");
      return result;
    },
  });
  const handleModeChange = useCallback(
    (next: ServerBrowserMode) => mutation.mutate(createServerBrowserModePatch(next)),
    [mutation],
  );
  const handleSaveCdpUrl = useCallback(
    () => mutation.mutate({ serverBrowser: { enabled: true, cdpUrl: cdpUrl.trim() } }),
    [cdpUrl, mutation],
  );
  const selected = useMemo(
    () => SERVER_BROWSER_MODES.find((entry) => entry.mode === mode) ?? SERVER_BROWSER_MODES[0],
    [mode],
  );
  const selectedDisplay = useMemo(() => ({ label: selected.label }), [selected]);
  const error = mutation.error instanceof Error ? mutation.error.message : null;

  return (
    <View style={settingsStyles.rowBorder}>
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{SERVER_BROWSER_TITLE}</Text>
          <Text style={settingsStyles.rowHint}>{selected.description}</Text>
          {mode !== "off" && status?.unavailableReason ? (
            <Text style={settingsStyles.rowError}>{status.unavailableReason}</Text>
          ) : null}
          {error ? <Text style={settingsStyles.rowError}>{error}</Text> : null}
        </View>
        <View style={styles.select}>
          <SelectField
            label="Server-side browser"
            field={false}
            value={mode}
            selectedDisplay={selectedDisplay}
            options={MODE_OPTIONS}
            onChange={handleModeChange}
            placeholder="Off"
            emptyText="No engines"
            disabled={mutation.isPending}
            title="Server-side browser"
            size="sm"
            testID="host-page-server-browser-mode"
            triggerTestID="host-page-server-browser-mode-trigger"
          />
        </View>
      </View>
      {mode === "existing" ? (
        <View style={styles.fields}>
          <Field
            label="Chrome DevTools URL"
            hint={`Leave empty for ${SERVER_BROWSER_DEFAULT_CDP_URL}. Paseo never closes this browser or its other tabs.`}
          >
            <FormTextInput
              initialValue={cdpUrl}
              resetKey={savedCdpUrl}
              onChangeText={setCdpUrl}
              onSubmitEditing={handleSaveCdpUrl}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!mutation.isPending}
              placeholder={SERVER_BROWSER_DEFAULT_CDP_URL}
              testID="host-page-server-browser-cdp-url"
            />
          </Field>
          {cdpUrl.trim() !== savedCdpUrl ? (
            <Button onPress={handleSaveCdpUrl} disabled={mutation.isPending} size="sm">
              Save
            </Button>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Hosts from before engines: one switch, Headless (light) only. */
function ServerBrowserSwitchRow({ serverId }: { serverId: string }) {
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

const styles = StyleSheet.create((theme) => ({
  select: {
    minWidth: 180,
  },
  fields: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[2],
  },
}));
