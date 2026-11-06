import React, { memo, useCallback, useMemo, type ReactElement } from "react";
import { Text, View, type AccessibilityActionEvent } from "react-native";
import { Minus, Plus } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { PressHighlight } from "@/components/ui/press-highlight";

const ThemedMinus = withUnistyles(Minus);
const ThemedPlus = withUnistyles(Plus);
const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const ACCESSIBILITY_ACTIONS = [{ name: "increment" }, { name: "decrement" }] as const;

const CapStep = memo(function CapStep({
  step,
  on,
  onSelect,
}: {
  step: number;
  on: boolean;
  onSelect: (step: number) => void;
}): ReactElement {
  const press = useCallback(() => onSelect(step), [onSelect, step]);
  return (
    <PressHighlight
      onPress={press}
      style={styles.stepHit}
      accessibilityElementsHidden
      importantForAccessibility="no"
      testID={`prompt-cache-cap-step-${step}`}
    >
      <View style={[styles.step, on ? styles.stepOn : styles.stepOff]} />
    </PressHighlight>
  );
});

/**
 * The agent's warm-up cap per idle stretch, from 1 to the window's maximum. A row of steps, one
 * per warm-up, so each value is one tap and the range reads at a glance; the buttons and the
 * screen reader's adjust actions move it by one.
 */
export const WarmUpCapSlider = memo(function WarmUpCapSlider({
  value,
  max,
  coversText,
  onChange,
}: {
  value: number;
  max: number;
  /** How long the chosen cap keeps an idle agent warm, such as "40m". */
  coversText: string;
  onChange: (value: number) => void;
}): ReactElement {
  const set = useCallback(
    (next: number) => {
      const clamped = Math.min(max, Math.max(1, next));
      if (clamped !== value) onChange(clamped);
    },
    [max, onChange, value],
  );
  const decrease = useCallback(() => set(value - 1), [set, value]);
  const increase = useCallback(() => set(value + 1), [set, value]);
  const onAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === "increment") increase();
      if (event.nativeEvent.actionName === "decrement") decrease();
    },
    [decrease, increase],
  );
  const steps = Array.from({ length: max }, (_, index) => index + 1);
  const accessibilityValue = useMemo(() => ({ min: 1, max, now: value }), [max, value]);

  return (
    <View style={styles.block} testID="prompt-cache-cap-slider">
      <View style={styles.header}>
        <Text style={styles.label}>Cap per idle stretch</Text>
        <Text style={styles.value} testID="prompt-cache-cap-slider-value">
          {value} of {max} · covers {coversText}
        </Text>
      </View>
      <View style={styles.row}>
        <ToolbarButton
          label="Fewer warm-ups"
          compact
          disabled={value <= 1}
          onPress={decrease}
          testID="prompt-cache-cap-decrease"
        >
          <ThemedMinus size={14} uniProps={iconColorMapping} />
        </ToolbarButton>
        <View
          style={styles.track}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Warm-ups per idle stretch"
          accessibilityValue={accessibilityValue}
          accessibilityActions={ACCESSIBILITY_ACTIONS}
          onAccessibilityAction={onAccessibilityAction}
        >
          {steps.map((step) => (
            <CapStep key={step} step={step} on={step <= value} onSelect={set} />
          ))}
        </View>
        <ToolbarButton
          label="More warm-ups"
          compact
          disabled={value >= max}
          onPress={increase}
          testID="prompt-cache-cap-increase"
        >
          <ThemedPlus size={14} uniProps={iconColorMapping} />
        </ToolbarButton>
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme: Theme) => ({
  block: {
    gap: theme.spacing[1],
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  label: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  value: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  track: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  stepHit: {
    flex: 1,
    height: 24,
    justifyContent: "center",
  },
  step: {
    height: 6,
    borderRadius: 2,
  },
  stepOn: {
    backgroundColor: theme.colors.statusWarning,
  },
  stepOff: {
    backgroundColor: theme.colors.surface3,
  },
}));
