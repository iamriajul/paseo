import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { Maximize, Monitor, Smartphone, Tablet } from "lucide-react-native";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  BROWSER_DEVICE_SIZE_PRESETS,
  formatBrowserDevicePresetLabel,
  RESPONSIVE_BROWSER_DEVICE_LABEL_KEY,
  type BrowserDeviceKind,
  type BrowserDeviceSizeId,
  type BrowserDeviceSizePreset,
} from "./device-presets";

const ThemedMaximize = withUnistyles(Maximize);
const ThemedMonitor = withUnistyles(Monitor);
const ThemedSmartphone = withUnistyles(Smartphone);
const ThemedTablet = withUnistyles(Tablet);
const mutedIconMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

export function getBrowserDeviceIcon(kind: BrowserDeviceKind): typeof ThemedMaximize {
  if (kind === "phone") return ThemedSmartphone;
  if (kind === "tablet") return ThemedTablet;
  if (kind === "desktop") return ThemedMonitor;
  return ThemedMaximize;
}

/** A trigger icon for the selected preset, at the muted toolbar colour. */
export function BrowserDeviceIcon({ kind }: { kind: BrowserDeviceKind }): ReactElement {
  const Icon = getBrowserDeviceIcon(kind);
  return <Icon size={16} uniProps={mutedIconMapping} />;
}

function DeviceSizeMenuItem({
  preset,
  selected,
  responsiveLabel,
  onSelect,
}: {
  preset: BrowserDeviceSizePreset;
  selected: boolean;
  responsiveLabel: string;
  onSelect: (id: BrowserDeviceSizeId) => void;
}) {
  const Icon = getBrowserDeviceIcon(preset.kind);
  const handleSelect = useCallback(() => onSelect(preset.id), [onSelect, preset.id]);
  const leading = useMemo(() => <Icon size={16} uniProps={mutedIconMapping} />, [Icon]);
  return (
    <DropdownMenuItem
      onSelect={handleSelect}
      selected={selected}
      showSelectedCheck
      leading={leading}
      testID={`browser-device-${preset.id}`}
    >
      {formatBrowserDevicePresetLabel(preset, responsiveLabel)}
    </DropdownMenuItem>
  );
}

/** Every Browser pane's device sizes, for a DropdownMenuContent the pane owns. */
export function BrowserDeviceSizeMenuItems({
  selectedId,
  onSelect,
}: {
  selectedId: BrowserDeviceSizeId | null;
  onSelect: (id: BrowserDeviceSizeId) => void;
}): ReactElement {
  const { t } = useTranslation();
  const responsiveLabel = t(RESPONSIVE_BROWSER_DEVICE_LABEL_KEY);
  return (
    <>
      {BROWSER_DEVICE_SIZE_PRESETS.map((preset) => (
        <DeviceSizeMenuItem
          key={preset.id}
          preset={preset}
          selected={preset.id === selectedId}
          responsiveLabel={responsiveLabel}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}
