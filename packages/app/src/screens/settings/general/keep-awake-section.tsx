import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSection, SettingsSwitch } from "@/components/settings";
import { isNative } from "@/constants/platform";
import { useAppSettings } from "@/hooks/use-settings";

export function KeepAwakeSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const handleChange = useCallback(
    (keepScreenAwake: boolean) => void updateSettings({ keepScreenAwake }),
    [updateSettings],
  );

  if (!isNative) {
    return null;
  }

  return (
    <SettingsSection title={t("settings.general.display")}>
      <SettingsCard testID="keep-awake-card">
        <SettingsSwitch
          label={t("settings.general.keepAwake.label")}
          hint={t("settings.general.keepAwake.description")}
          value={settings.keepScreenAwake}
          onValueChange={handleChange}
          testID="keep-screen-awake-switch"
        />
      </SettingsCard>
    </SettingsSection>
  );
}
