import { useEffect, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";

// Chromium errors that mean "nothing answered yet": a dev server still
// starting, a restarting host tunnel, a dropped connection. A tab that hits one
// keeps retrying instead of staying on an empty page.
const RETRYABLE_LOAD_ERROR =
  /ERR_(CONNECTION_(REFUSED|RESET|CLOSED|FAILED|TIMED_OUT)|EMPTY_RESPONSE|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|NETWORK_CHANGED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|TIMED_OUT|SOCKET_NOT_CONNECTED)/;
const MAX_RETRY_DELAY_SECONDS = 30;

export function isAutoRetryableLoadError(message: string): boolean {
  return RETRYABLE_LOAD_ERROR.test(message);
}

/** 2, 4, 8, 16, 30, 30… seconds for attempt 1, 2, 3… */
export function autoRetryDelaySeconds(attempt: number): number {
  return Math.min(MAX_RETRY_DELAY_SECONDS, 2 ** Math.max(1, Math.min(attempt, 5)));
}

/**
 * Covers the webview area when the main frame failed or the guest crashed.
 * Electron draws nothing for a failed load, so without this the tab is an
 * empty (black in dark themes) surface with no explanation.
 */
export function BrowserLoadFailure(props: {
  title: string;
  message: string;
  /** Seconds until the pane retries by itself; null when it waits for the user. */
  retryInSeconds: number | null;
  onRetry: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const remaining = useCountdown(props.retryInSeconds);
  return (
    <View style={styles.container} testID="browser-load-failure">
      <View style={styles.card}>
        <Text style={styles.title} role="alert">
          {props.title}
        </Text>
        <Text style={styles.message} selectable>
          {props.message}
        </Text>
        <View style={styles.actions}>
          <Button variant="secondary" onPress={props.onRetry} testID="browser-load-retry">
            {t("workspace.browser.errors.retry")}
          </Button>
          {remaining !== null ? (
            <Text style={styles.status}>
              {t("workspace.browser.errors.retryingIn", { seconds: remaining })}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function useCountdown(seconds: number | null): number | null {
  const [remaining, setRemaining] = useState(seconds);
  useEffect(() => {
    setRemaining(seconds);
    if (seconds === null) {
      return undefined;
    }
    const interval = setInterval(() => {
      setRemaining((current) => (current === null || current <= 0 ? current : current - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [seconds]);
  return remaining;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface0,
  },
  card: {
    maxWidth: 520,
    gap: theme.spacing[2],
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  message: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    marginTop: theme.spacing[1],
  },
  status: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
