import React from "react";
import { ListTodo } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";
import { WorkspaceTodoPane } from "@/todos/workspace-todo-pane";

const ThemedListTodo = withUnistyles(ListTodo);

export const todoPanelPresentation = {
  label: (t) => t("panels.todo.label"),
  subtitle: (t) => t("panels.todo.subtitle"),
  tooltip: (t) => t("panels.todo.tooltip"),
  icon: ThemedListTodo,
} satisfies PanelPresentation;

function TodoPanel() {
  const { serverId, workspaceId, target } = usePaneContext();
  invariant(target.kind === "todo", "TodoPanel requires todo target");
  return <WorkspaceTodoPane serverId={serverId} workspaceId={workspaceId} />;
}

export const todoPanelRegistration = definePanel("todo", {
  component: TodoPanel,
  presentation: todoPanelPresentation,
});
