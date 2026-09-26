import { useCallback, useState } from "react";
import { Alert, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { settingsStyles } from "@/styles/settings";

export function CliproxyapiSettingsCard({ serverId }: { serverId: string }) {
  const { config, patchConfig } = useDaemonConfig(serverId);
  const saved = config?.cliproxyapi;
  const [enabled, setEnabled] = useState(saved?.enabled === true);
  const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(saved?.apiKey ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const resetKey = `${saved?.enabled ?? false}:${saved?.baseUrl ?? ""}:${saved?.apiKey ?? ""}`;

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await patchConfig({
        cliproxyapi: {
          enabled,
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim(),
        },
      });
    } catch (error) {
      Alert.alert(
        "Couldn't save CLIProxyAPI",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setIsSaving(false);
    }
  }, [apiKey, baseUrl, enabled, patchConfig]);

  return (
    <SettingsSection title="CLIProxyAPI" testID="host-page-cliproxyapi-card">
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Route harnesses through CLIProxyAPI</Text>
            <Text style={settingsStyles.rowHint}>
              Restart the daemon after saving. Env vars PASEO_CLIPROXYAPI_BASE_URL and
              PASEO_CLIPROXYAPI_API_KEY override this card.
            </Text>
          </View>
          <Switch
            value={enabled}
            onValueChange={setEnabled}
            disabled={isSaving}
            accessibilityLabel="Enable CLIProxyAPI"
            testID="host-page-cliproxyapi-switch"
          />
        </View>
        {enabled ? (
          <View style={styles.fields}>
            <Field label="Base URL">
              <FormTextInput
                initialValue={baseUrl}
                resetKey={resetKey}
                onChangeText={setBaseUrl}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!isSaving}
                placeholder="http://cliproxyapi-host:8317"
                testID="host-page-cliproxyapi-base-url"
              />
            </Field>
            <Field label="API key">
              <FormTextInput
                initialValue={apiKey}
                resetKey={`${resetKey}:key`}
                onChangeText={setApiKey}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                editable={!isSaving}
                placeholder="sk-..."
                testID="host-page-cliproxyapi-api-key"
              />
            </Field>
            <Button onPress={handleSave} disabled={isSaving}>
              Save
            </Button>
          </View>
        ) : null}
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  fields: {
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  },
}));
