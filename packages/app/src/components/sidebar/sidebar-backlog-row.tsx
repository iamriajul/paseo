import { router } from "expo-router";
import { ListTodo, Plus } from "lucide-react-native";
import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { usePathname } from "expo-router";
import { Pressable } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { useCreateBacklogTaskStore } from "@/stores/create-backlog-task-store";
import type { Theme } from "@/styles/theme";
import { ICON_SIZE } from "@/styles/theme";
import { buildBacklogRoute } from "@/utils/host-routes";

interface SidebarBacklogRowProps {
  onBeforeNavigate?: () => void;
}

/**
 * Fork-owned Backlog entry rendered alongside the preference-driven
 * SidebarNavRows. It stays outside the nav model on purpose: the model's
 * exact-list unit tests and the nav-settings e2e spec pin the four upstream
 * builtins, and a fifth builtin would force edits to both. The row matches
 * the builtins' compact styling and testIDs so it reads as one group.
 */
export const SidebarBacklogRow = memo(function SidebarBacklogRow({
  onBeforeNavigate,
}: SidebarBacklogRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const openCreateBacklogTask = useCreateBacklogTaskStore((state) => state.openCreateBacklogTask);
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildBacklogRoute());
  }, [onBeforeNavigate]);
  const handleCreateTask = useCallback(() => {
    onBeforeNavigate?.();
    openCreateBacklogTask();
  }, [onBeforeNavigate, openCreateBacklogTask]);
  const ThemedPlus = useMemo(() => withUnistyles(Plus), []);
  const addButton = useMemo(
    () => (
      <Pressable
        onPress={handleCreateTask}
        accessibilityRole="button"
        accessibilityLabel="Add task"
        testID="sidebar-backlog-add"
        hitSlop={8}
      >
        <ThemedPlus
          size={ICON_SIZE.sm}
          uniProps={(theme: Theme) => ({ color: theme.colors.foregroundMuted })}
        />
      </Pressable>
    ),
    [ThemedPlus, handleCreateTask],
  );

   return (
     <SidebarHeaderRow
       icon={ListTodo}
       label={t("sidebar.sections.backlog")}
       onPress={handlePress}
       isActive={pathname.includes("/backlog")}
       testID="sidebar-backlog"
       variant="compact"
      trailing={addButton}
     />
   );
});
