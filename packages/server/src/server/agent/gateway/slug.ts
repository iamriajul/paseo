// gateway/slug.ts — map a Paseo provider model id to the CLIProxyAPI slug the
// Gateway itself knows the model by. Shared by every Gateway read that filters
// on a model (`/v1/quota`, `/v1/last-request-tps`), so those two never drift on
// what counts as a Gateway-routed id.
import { decodeCliproxyClaudeModelId } from "./models.js";

/**
 * Returns null when the model is not Gateway-routed (native opencode/omp
 * provider prefixes, providers the Gateway does not serve, blank ids).
 */
export function resolveGatewayModelSlug(provider: string, model: string): string | null {
  const trimmed = model.trim();
  if (!trimmed) return null;
  if (provider === "opencode") {
    return stripProviderPrefix(trimmed, "cliproxyapi/");
  }
  if (provider === "omp") {
    return stripProviderPrefix(trimmed, "litellm/");
  }
  if (provider === "claude") {
    return stripGatewaySuffix(decodeCliproxyClaudeModelId(trimmed));
  }
  if (provider === "codex") {
    return stripGatewaySuffix(trimmed);
  }
  return null;
}

function stripProviderPrefix(model: string, prefix: string): string | null {
  if (!model.startsWith(prefix)) return null;
  return stripGatewaySuffix(model.slice(prefix.length));
}

function stripGatewaySuffix(model: string): string | null {
  const stripped = model
    .replace(/\([^()]*\)$/, "")
    .replace(/\[[^\][]*\]$/, "")
    .trim();
  return stripped.length > 0 ? stripped : null;
}
