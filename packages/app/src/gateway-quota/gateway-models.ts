import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";

export interface GatewayModelOption {
  id: string;
  label: string;
}

/**
 * Whether CLIProxyAPI serves the model, from the provider catalog alone: discovered rows carry
 * `source: "cliproxyapi"` (or the OpenCode/OMP prefix), and Claude manifest rows the gateway also
 * advertises carry `cliproxyapiAdvertised`.
 */
export function isGatewayModel(model: AgentModelDefinition): boolean {
  if (model.metadata?.source === "cliproxyapi") return true;
  if (model.metadata?.cliproxyapiAdvertised === true) return true;
  return model.id.startsWith("cliproxyapi/") || model.id.startsWith("litellm/");
}

/**
 * The models the accounts window offers: every gateway model in the agent's provider catalog, the
 * agent's own model first even when the catalog has not loaded or does not list it.
 */
export function buildGatewayModelOptions(
  models: readonly AgentModelDefinition[] | undefined,
  current: string | null | undefined,
): GatewayModelOption[] {
  const options: GatewayModelOption[] = [];
  const seen = new Set<string>();
  const currentRow = current ? models?.find((model) => model.id === current) : undefined;
  if (current) {
    options.push({ id: current, label: currentRow?.label ?? current });
    seen.add(current);
  }
  const rest = (models ?? [])
    .filter((model) => model.isSelectable !== false && isGatewayModel(model) && !seen.has(model.id))
    .map((model) => ({ id: model.id, label: model.label || model.id }))
    .sort((a, b) => a.label.localeCompare(b.label));
  for (const option of rest) {
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    options.push(option);
  }
  return options;
}
