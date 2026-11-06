import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  SettingsCard,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@/components/settings";
import {
  PROMPT_CACHE_CAP_WARNING_MINUTES,
  useAppSettings,
  type PromptCacheCapWarningMinutes,
} from "@/hooks/use-settings";

type CapWarningValue = `${PromptCacheCapWarningMinutes}`;

/** Client-side preferences for the Claude prompt-cache surfaces in the composer and insights. */
export function PromptCacheSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();

  const capWarningOptions = useMemo(
    () =>
      PROMPT_CACHE_CAP_WARNING_MINUTES.map((minutes) => ({
        value: String(minutes) as CapWarningValue,
        label: t(`settings.general.promptCache.capWarning.options.${minutes}`),
      })),
    [t],
  );
  const changeCapWarning = useCallback(
    (value: CapWarningValue) =>
      void updateSettings({
        promptCacheCapWarningMinutes: Number(value) as PromptCacheCapWarningMinutes,
      }),
    [updateSettings],
  );

  const changeMoneyStats = useCallback(
    (promptCacheMoneyStats: boolean) => void updateSettings({ promptCacheMoneyStats }),
    [updateSettings],
  );

  return (
    <SettingsSection title={t("settings.general.promptCache.title")}>
      <SettingsCard>
        <SettingsSwitch
          label={t("settings.general.promptCache.moneyStats.label")}
          hint={t("settings.general.promptCache.moneyStats.description")}
          value={settings.promptCacheMoneyStats}
          onValueChange={changeMoneyStats}
          testID="settings-prompt-cache-money-stats"
        />
        <SettingsSelect
          label={t("settings.general.promptCache.capWarning.label")}
          hint={t("settings.general.promptCache.capWarning.description")}
          value={String(settings.promptCacheCapWarningMinutes) as CapWarningValue}
          options={capWarningOptions}
          onValueChange={changeCapWarning}
          testID="settings-prompt-cache-cap-warning"
        />
      </SettingsCard>
    </SettingsSection>
  );
}
