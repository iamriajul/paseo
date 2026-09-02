import { useCallback, useMemo, useRef, type ReactElement, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Maximize,
  Monitor,
  MousePointer2,
  RotateCw,
  Smartphone,
  Tablet,
  Wrench,
} from "lucide-react-native";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  BROWSER_DEVICE_SIZE_PRESETS,
  formatBrowserDevicePresetLabel,
  getBrowserDevicePreset,
  RESPONSIVE_BROWSER_DEVICE_LABEL_KEY,
  type BrowserDeviceSizeId,
  type BrowserDeviceSizePreset,
} from "@/desktop/browser/device-presets";
import {
  createFixedBrowserViewport,
  RESPONSIVE_BROWSER_VIEWPORT,
  type BrowserViewport,
} from "@/desktop/browser/store";
import type { WebNavigationState } from "./web-navigation";

const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedArrowRight = withUnistyles(ArrowRight);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedMaximize = withUnistyles(Maximize);
const ThemedMonitor = withUnistyles(Monitor);
const ThemedMousePointer2 = withUnistyles(MousePointer2);
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedSmartphone = withUnistyles(Smartphone);
const ThemedTablet = withUnistyles(Tablet);
const ThemedWrench = withUnistyles(Wrench);
const ThemedUrlInput = withUnistyles(EditingTextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

const mutedIconMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});
const accentIconMapping = (theme: { colors: { accent: string } }) => ({
  color: theme.colors.accent,
});

interface PressableVisualState {
  hovered?: boolean;
  pressed?: boolean;
}

const triggerStyle = ({ hovered, pressed }: PressableVisualState) => [
  styles.iconButton,
  (hovered || pressed) && styles.iconButtonHovered,
];

function getDeviceIcon(kind: BrowserDeviceSizePreset["kind"]): typeof ThemedMaximize {
  if (kind === "phone") return ThemedSmartphone;
  if (kind === "tablet") return ThemedTablet;
  if (kind === "desktop") return ThemedMonitor;
  return ThemedMaximize;
}

function ToolbarButton({
  label,
  active,
  disabled,
  onPress,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  const accessibilityState = useMemo(
    () => ({ disabled: Boolean(disabled), selected: Boolean(active) }),
    [active, disabled],
  );
  const buttonStyle = useCallback(
    ({ hovered, pressed }: PressableVisualState) => [
      styles.iconButton,
      active && styles.iconButtonActive,
      (hovered || pressed) && styles.iconButtonHovered,
      disabled && styles.iconButtonDisabled,
    ],
    [active, disabled],
  );
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild disabled={disabled}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={accessibilityState}
          disabled={disabled}
          onPress={onPress}
          style={buttonStyle}
        >
          {children}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="center" offset={8}>
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
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
  const Icon = getDeviceIcon(preset.kind);
  const handleSelect = useCallback(() => onSelect(preset.id), [onSelect, preset.id]);
  const leading = useMemo(() => <Icon size={16} uniProps={mutedIconMapping} />, [Icon]);
  return (
    <DropdownMenuItem
      onSelect={handleSelect}
      selected={selected}
      showSelectedCheck
      leading={leading}
    >
      {formatBrowserDevicePresetLabel(preset, responsiveLabel)}
    </DropdownMenuItem>
  );
}

function DeviceSizeMenu({
  selectedId,
  onSelect,
}: {
  selectedId: BrowserDeviceSizeId | null;
  onSelect: (id: BrowserDeviceSizeId) => void;
}) {
  const { t } = useTranslation();
  // A fixed viewport that matches no preset has no icon of its own; fall back to
  // the responsive one so the trigger still renders, and tick nothing.
  const SelectedIcon = getDeviceIcon(getBrowserDevicePreset(selectedId ?? "responsive").kind);
  const label = t("workspace.browser.devices.label");
  const responsiveLabel = t(RESPONSIVE_BROWSER_DEVICE_LABEL_KEY);
  return (
    <DropdownMenu>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger accessibilityLabel={label} style={triggerStyle}>
            <View style={styles.deviceTrigger}>
              <SelectedIcon size={16} uniProps={mutedIconMapping} />
              <ThemedChevronDown size={12} uniProps={mutedIconMapping} />
            </View>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <Text style={styles.tooltipText}>{label}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" scrollable maxHeight={360}>
        {BROWSER_DEVICE_SIZE_PRESETS.map((preset) => (
          <DeviceSizeMenuItem
            key={preset.id}
            preset={preset}
            selected={preset.id === selectedId}
            responsiveLabel={responsiveLabel}
            onSelect={onSelect}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function deviceSizeIdForViewport(viewport: BrowserViewport): BrowserDeviceSizeId | null {
  if (viewport.mode === "responsive") {
    return "responsive";
  }
  return (
    BROWSER_DEVICE_SIZE_PRESETS.find(
      (preset) => preset.width === viewport.width && preset.height === viewport.height,
    )?.id ?? null
  );
}

interface WebBrowserToolbarProps {
  state: WebNavigationState;
  bridgeAvailable: boolean;
  isSelecting: boolean;
  isErudaOpen: boolean;
  viewport: BrowserViewport;
  onSubmitUrl: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onToggleEruda: () => void;
  onToggleSelect: () => void;
  onChangeViewport: (viewport: BrowserViewport) => void;
}

// Chrome for the web pane's iframe. `bridgeAvailable` gates devtools and select
// only: those two have nothing to fall back on, so without the injected bridge
// they render inert rather than accepting a press and dropping it. Back and
// forward gate on `canGoBack`/`canGoForward` alone, which the reducer maintains
// on both paths — bridge-reported while a bridge is live, a parent-side stack of
// URL-bar moves when there is none — so they keep working on a direct URL, which
// is what the design's degradation table promises. Reload never needs the bridge
// either; the pane remounts the iframe instead.
export function WebBrowserToolbar({
  state,
  bridgeAvailable,
  isSelecting,
  isErudaOpen,
  viewport,
  onSubmitUrl,
  onBack,
  onForward,
  onReload,
  onToggleEruda,
  onToggleSelect,
  onChangeViewport,
}: WebBrowserToolbarProps): ReactElement {
  const { t } = useTranslation();
  const urlInputRef = useRef<EditingTextInputHandle | null>(null);

  const handleSubmitUrl = useCallback(() => {
    onSubmitUrl(urlInputRef.current?.getText() ?? state.displayUrl);
  }, [onSubmitUrl, state.displayUrl]);

  const selectedDeviceSizeId = useMemo(() => deviceSizeIdForViewport(viewport), [viewport]);
  const handleSelectDeviceSize = useCallback(
    (id: BrowserDeviceSizeId) => {
      const preset = getBrowserDevicePreset(id);
      onChangeViewport(
        preset.width === null || preset.height === null
          ? RESPONSIVE_BROWSER_VIEWPORT
          : createFixedBrowserViewport(preset.width, preset.height),
      );
    },
    [onChangeViewport],
  );

  return (
    <View style={styles.toolbar}>
      <View style={styles.group}>
        <ToolbarButton
          label={t("workspace.browser.controls.back")}
          disabled={!state.canGoBack}
          onPress={onBack}
        >
          <ThemedArrowLeft size={16} uniProps={mutedIconMapping} />
        </ToolbarButton>
        <ToolbarButton
          label={t("workspace.browser.controls.forward")}
          disabled={!state.canGoForward}
          onPress={onForward}
        >
          <ThemedArrowRight size={16} uniProps={mutedIconMapping} />
        </ToolbarButton>
        <ToolbarButton label={t("workspace.browser.controls.refresh")} onPress={onReload}>
          <ThemedRotateCw size={16} uniProps={mutedIconMapping} />
        </ToolbarButton>
      </View>
      <View style={styles.urlBarWrap}>
        {/* key remounts the field so it resyncs whenever the bridge reports a new URL. */}
        <ThemedUrlInput
          key={state.displayUrl}
          ref={urlInputRef}
          accessibilityLabel={t("workspace.browser.controls.browserUrl")}
          autoCapitalize="none"
          autoCorrect={false}
          initialValue={state.displayUrl}
          onSubmitEditing={handleSubmitUrl}
          placeholder={t("workspace.browser.controls.enterUrl")}
          style={styles.urlInput}
        />
      </View>
      <View style={styles.group}>
        <DeviceSizeMenu selectedId={selectedDeviceSizeId} onSelect={handleSelectDeviceSize} />
        <ToolbarButton
          label={t("workspace.browser.controls.openDevTools")}
          active={isErudaOpen}
          disabled={!bridgeAvailable}
          onPress={onToggleEruda}
        >
          <ThemedWrench size={16} uniProps={isErudaOpen ? accentIconMapping : mutedIconMapping} />
        </ToolbarButton>
        <ToolbarButton
          label={
            isSelecting
              ? t("workspace.browser.controls.cancelSelector")
              : t("workspace.browser.controls.annotateElement")
          }
          active={isSelecting}
          disabled={!bridgeAvailable}
          onPress={onToggleSelect}
        >
          <ThemedMousePointer2
            size={16}
            uniProps={isSelecting ? accentIconMapping : mutedIconMapping}
          />
        </ToolbarButton>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  group: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  iconButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  iconButtonActive: {
    backgroundColor: `${String(theme.colors.accent)}20`,
  },
  iconButtonDisabled: {
    opacity: 0.45,
  },
  urlBarWrap: {
    flex: 1,
    minWidth: 0,
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  urlInput: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  deviceTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
}));
