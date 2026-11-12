import { useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useToast } from "@/contexts/toast-api-context";
import type { PublicPageUrl } from "@/port-forward/public-page-url";
import { openExternalUrl } from "@/utils/open-external-url";

const ThemedExternalLink = withUnistyles(ExternalLink);
const muted = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

/**
 * Opens a server tab's page in this device's own browser where nothing can forward its ports
 * (iOS, the web build, a non-loopback page): at its URL, or at the public URL the host serves for
 * a loopback port. Without one, says what the host needs.
 */
export function ServerBrowserOpenInBrowserButton(props: {
  publicPage: PublicPageUrl | null;
}): ReactElement | null {
  const { t } = useTranslation();
  const toast = useToast();
  const { publicPage } = props;
  const handlePress = useCallback(() => {
    if (!publicPage) return;
    if (publicPage.kind === "none") {
      toast.show(t("workspace.browser.openInBrowser.noPublicUrl", { port: publicPage.port }), {
        variant: "warning",
      });
      return;
    }
    void openExternalUrl(publicPage.url);
  }, [publicPage, t, toast]);
  if (!publicPage) return null;
  const label = t("workspace.browser.openInBrowser.label");
  return (
    <ToolbarButton label={label} onPress={handlePress} testID="server-browser-open-in-browser">
      <ThemedExternalLink size={16} uniProps={muted} />
    </ToolbarButton>
  );
}
