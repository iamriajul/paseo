import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { MenuItem, MenuSubTrigger, type MenuPageDefinition } from "@/components/ui/menu";
import { getIsElectron } from "@/constants/platform";
import { useAppSettings } from "@/hooks/use-settings";
import {
  useAgentBringToFrontOverride,
  useAgentBringToFrontStore,
} from "@/stores/agent-bring-to-front-store";
import type { AgentBringToFrontOverride } from "@/utils/attention-interrupt-plan";

const PAGE_ID = "agentBringToFront";
const NO_PAGES: readonly MenuPageDefinition[] = [];

export interface AgentBringToFrontMenu {
  /** The "Bring to front" row, or null off the desktop app. */
  trigger: ReactElement | null;
  /** The page the row opens; pass to the menu surface. */
  pages: readonly MenuPageDefinition[];
}

const NO_MENU: AgentBringToFrontMenu = { trigger: null, pages: NO_PAGES };

/**
 * Per-agent "Bring Paseo to the front" for an agent tab's menu: Default (follow the global
 * setting), Always or Never. Desktop app only, like the setting it overrides.
 */
export function useAgentBringToFrontMenu(
  target: { serverId: string; agentId: string } | null,
  testIDBase: string,
): AgentBringToFrontMenu {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const serverId = target?.serverId ?? "";
  const agentId = target?.agentId ?? "";
  const override = useAgentBringToFrontOverride(serverId, agentId);
  const globalEnabled = settings.attentionIntrusiveMode;
  const enabled = target !== null && getIsElectron();

  return useMemo(() => {
    if (!enabled) return NO_MENU;
    const title = t("workspace.tabs.menu.bringToFront.label");
    const value = t(`workspace.tabs.menu.bringToFront.${override ?? "default"}`);
    const options: { value: AgentBringToFrontOverride | null; label: string; key: string }[] = [
      {
        value: null,
        key: "default",
        label: globalEnabled
          ? t("workspace.tabs.menu.bringToFront.defaultOn")
          : t("workspace.tabs.menu.bringToFront.defaultOff"),
      },
      { value: "always", key: "always", label: t("workspace.tabs.menu.bringToFront.always") },
      { value: "never", key: "never", label: t("workspace.tabs.menu.bringToFront.never") },
    ];
    return {
      trigger: (
        <MenuSubTrigger
          id={PAGE_ID}
          value={value}
          indicator={override !== null}
          testID={`${testIDBase}-bring-to-front`}
        >
          {title}
        </MenuSubTrigger>
      ),
      pages: [
        {
          id: PAGE_ID,
          title,
          content: (
            <>
              {options.map((option) => (
                <OverrideItem
                  key={option.key}
                  serverId={serverId}
                  agentId={agentId}
                  value={option.value}
                  label={option.label}
                  selected={override === option.value}
                  testID={`${testIDBase}-bring-to-front-${option.key}`}
                />
              ))}
            </>
          ),
        },
      ],
    };
  }, [enabled, override, globalEnabled, serverId, agentId, t, testIDBase]);
}

function OverrideItem({
  serverId,
  agentId,
  value,
  label,
  selected,
  testID,
}: {
  serverId: string;
  agentId: string;
  value: AgentBringToFrontOverride | null;
  label: string;
  selected: boolean;
  testID: string;
}) {
  const handleSelect = useCallback(() => {
    useAgentBringToFrontStore.getState().setOverride(serverId, agentId, value);
  }, [serverId, agentId, value]);
  return (
    <MenuItem selected={selected} showSelectedCheck onSelect={handleSelect} testID={testID}>
      {label}
    </MenuItem>
  );
}
