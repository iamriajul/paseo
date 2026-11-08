import { useCallback, useMemo } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  SettingsCard,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@/components/settings";
import { isNative } from "@/constants/platform";
import { useAppSettings, type AgentMessagesDisplay, type ChatDisplay } from "@/hooks/use-settings";
import { AGENT_MESSAGES_DISPLAYS } from "@/chat-display/agent-messages-override";
import { PromptCacheSection } from "./prompt-cache-section";

const CHAT_DISPLAYS: readonly ChatDisplay[] = ["full", "collapseToolCalls", "collapseTurns"];

export function ChatSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();

  const chatDisplayOptions = useMemo(
    () =>
      CHAT_DISPLAYS.map((value) => ({
        value,
        label: t(`settings.general.chatDisplay.options.${value}`),
      })),
    [t],
  );

  const agentMessagesOptions = useMemo(
    () =>
      AGENT_MESSAGES_DISPLAYS.map((value) => ({
        value,
        label: t(`settings.general.agentMessagesDisplay.options.${value}`),
      })),
    [t],
  );

  const changeAgentMessagesDisplay = useCallback(
    (agentMessagesDisplay: AgentMessagesDisplay) => void updateSettings({ agentMessagesDisplay }),
    [updateSettings],
  );
  const changeChatDisplay = useCallback(
    (chatDisplay: ChatDisplay) => void updateSettings({ chatDisplay }),
    [updateSettings],
  );
  const changeAutoExpandReasoning = useCallback(
    (autoExpandReasoning: boolean) => void updateSettings({ autoExpandReasoning }),
    [updateSettings],
  );
  const changeChatOutline = useCallback(
    (chatOutlineEnabled: boolean) => void updateSettings({ chatOutlineEnabled }),
    [updateSettings],
  );

  return (
    <View>
      <SettingsSection title={t("settings.appearance.detailLevel.title")}>
        <SettingsCard>
          <SettingsSwitch
            label={t("settings.general.autoExpandReasoning.label")}
            hint={t("settings.general.autoExpandReasoning.description")}
            value={settings.autoExpandReasoning}
            onValueChange={changeAutoExpandReasoning}
          />
          <SettingsSelect
            label={t("settings.general.chatDisplay.label")}
            hint={t("settings.general.chatDisplay.description")}
            value={settings.chatDisplay}
            options={chatDisplayOptions}
            onValueChange={changeChatDisplay}
          />
          <SettingsSelect
            label={t("settings.general.agentMessagesDisplay.label")}
            hint={t("settings.general.agentMessagesDisplay.description")}
            value={settings.agentMessagesDisplay}
            options={agentMessagesOptions}
            onValueChange={changeAgentMessagesDisplay}
            testID="settings-agent-messages-display"
          />
          {isNative ? null : (
            <SettingsSwitch
              label={t("settings.appearance.chatOutline.title")}
              hint={t("settings.appearance.chatOutline.description")}
              value={settings.chatOutlineEnabled}
              onValueChange={changeChatOutline}
            />
          )}
        </SettingsCard>
      </SettingsSection>
      <PromptCacheSection />
    </View>
  );
}
