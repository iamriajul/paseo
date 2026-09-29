import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

import { resolvePaseoHome } from "../../paseo-home.js";

const execFileAsync = promisify(execFile);

export const CODEX_MODEL_CATALOG_FILENAME = "codex-model-catalog.json";
export const CODEX_FALLBACK_DEFAULT_CONTEXT_WINDOW = 272_000;
export const CODEX_LONG_CONTEXT_WINDOW_THRESHOLD = 1_000_000;

export const DEFAULT_CODEX_MODEL_TEMPLATE: Record<string, unknown> = {
  shell_type: "unified_exec",
  visibility: "list",
  supported_in_api: true,
  priority: 1,
  additional_speed_tiers: ["fast"],
  service_tiers: [],
  supported_reasoning_levels: [],
  default_reasoning_summary: "none",
  support_verbosity: true,
  default_verbosity: "low",
  apply_patch_tool_type: "freeform",
  web_search_tool_type: "text_and_image",
  truncation_policy: { mode: "tokens", limit: 10000 },
  supports_image_detail_original: true,
  context_window: CODEX_FALLBACK_DEFAULT_CONTEXT_WINDOW,
  max_context_window: CODEX_FALLBACK_DEFAULT_CONTEXT_WINDOW,
  effective_context_window_percent: 95,
  experimental_supported_tools: [],
  input_modalities: ["text", "image"],
  supports_search_tool: false,
  supports_experimental_context: false,
  use_responses_lite: false,
  node_repl_auto_review_required: false,
  node_repl_disabled: false,
};

let cachedBundledModels: Array<Record<string, unknown>> | null = null;

function readFinitePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function resolveCatalogDisplayName(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function resolveCatalogWindowLimits(record: Record<string, unknown>): {
  contextWindow: number;
  maxContextWindow: number;
  effectivePercent: number;
} {
  const rawContext = readFinitePositiveNumber(record.context_window);
  const rawMaxContext = readFinitePositiveNumber(record.max_context_window);
  const contextWindow =
    rawMaxContext !== undefined || rawContext !== undefined
      ? Math.max(rawContext ?? 0, rawMaxContext ?? 0)
      : CODEX_FALLBACK_DEFAULT_CONTEXT_WINDOW;
  const maxContextWindow = Math.max(rawMaxContext ?? 0, contextWindow);
  const effectivePercent =
    contextWindow >= CODEX_LONG_CONTEXT_WINDOW_THRESHOLD
      ? 100
      : (readFinitePositiveNumber(record.effective_context_window_percent) ?? 95);
  return { contextWindow, maxContextWindow, effectivePercent };
}

function normalizeCatalogVisibility(value: unknown, fallback: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  } else if (Array.isArray(value)) {
    if (value.includes("hide")) return "hide";
    if (value.includes("list")) return "list";
  }
  if (typeof fallback === "string") {
    const trimmedFallback = fallback.trim();
    if (trimmedFallback.length > 0) return trimmedFallback;
  }
  return "list";
}

function normalizeCatalogReasoningLevel(
  entry: unknown,
): { effort: string; description: string } | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.effort !== "string") return null;
  const effort = record.effort.trim();
  if (!effort) return null;
  const rawDescription = record.description;
  if (typeof rawDescription === "string" && rawDescription.trim().length > 0) {
    return { effort, description: rawDescription };
  }
  return { effort, description: effort };
}

function resolveCatalogReasoningLevels(
  value: unknown,
  fallback: unknown,
): Array<{
  effort: string;
  description: string;
}> {
  if (Array.isArray(value)) {
    const levels: Array<{ effort: string; description: string }> = [];
    for (const entry of value) {
      const normalized = normalizeCatalogReasoningLevel(entry);
      if (normalized) levels.push(normalized);
    }
    if (levels.length > 0) return levels;
  }
  if (Array.isArray(fallback)) {
    const levels: Array<{ effort: string; description: string }> = [];
    for (const entry of fallback) {
      const normalized = normalizeCatalogReasoningLevel(entry);
      if (normalized) levels.push(normalized);
    }
    if (levels.length > 0) return levels;
  }
  return [];
}

function isValidCatalogReasoningLevel(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.effort === "string" && typeof entry.description === "string";
}

function isValidCatalogModel(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.visibility !== "string") return false;
  if (!Array.isArray(record.supported_reasoning_levels)) return false;
  for (const level of record.supported_reasoning_levels) {
    if (!isValidCatalogReasoningLevel(level)) return false;
  }
  return true;
}

/**
 * Normalizes a raw model record to ensure it contains all required fields of
 * Codex's `ModelInfo` serde struct, setting `context_window` and `max_context_window`
 * to the full advertised capacity and enabling 100% effective context window for 1M+ models.
 *
 * Gateway-discovered rows only carry a subset (`slug`, `display_name`,
 * `supported_reasoning_levels: [{ effort }]` without `description`, and
 * `visibility: []`). Codex rejects those shapes verbatim: `visibility` must be
 * a string (or single-key map), and every reasoning level requires a
 * `description`. Both are repaired here so the written catalog parses.
 */
export function normalizeCodexCatalogModel(
  input: unknown,
  baseTemplate: Record<string, unknown> = DEFAULT_CODEX_MODEL_TEMPLATE,
): Record<string, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const slug = typeof record.slug === "string" ? record.slug.trim() : "";
  if (!slug) return null;

  const displayName = resolveCatalogDisplayName(record.display_name, slug);
  const { contextWindow, maxContextWindow, effectivePercent } = resolveCatalogWindowLimits(record);
  // Gateway rows arrive with `visibility: []`; Codex requires a string ("list"/"hide").
  // Preserve an explicit hide marker, otherwise default to visible.
  const visibility = normalizeCatalogVisibility(record.visibility, baseTemplate.visibility);
  // Gateway reasoning entries are `{ effort }` without `description`, which Codex
  // rejects with `missing field description`. Fill from the entry's own effort.
  const supportedReasoningLevels = resolveCatalogReasoningLevels(
    record.supported_reasoning_levels,
    baseTemplate.supported_reasoning_levels,
  );

  return {
    ...baseTemplate,
    ...record,
    slug,
    display_name: displayName,
    context_window: contextWindow,
    max_context_window: maxContextWindow,
    effective_context_window_percent: effectivePercent,
    shell_type: typeof record.shell_type === "string" ? record.shell_type : baseTemplate.shell_type,
    visibility,
    supported_in_api:
      record.supported_in_api !== undefined
        ? record.supported_in_api
        : baseTemplate.supported_in_api,
    priority: typeof record.priority === "number" ? record.priority : baseTemplate.priority,
    supported_reasoning_levels: supportedReasoningLevels,
  };
}

/**
 * Read the bundled model catalog shipped with the local `codex` binary via `codex debug models --bundled`.
 * Returns cached results if already resolved; falls back to an empty list on failure or missing binary.
 */
export async function resolveBundledCodexModels(launchPrefix?: {
  command: string;
  args: string[];
}): Promise<Array<Record<string, unknown>>> {
  if (cachedBundledModels) return cachedBundledModels;

  const command = launchPrefix?.command ?? "codex";
  const args = [...(launchPrefix?.args ?? []), "debug", "models", "--bundled"];

  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 4_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    if (parsed && Array.isArray(parsed.models)) {
      const models = parsed.models.filter(
        (m: unknown): m is Record<string, unknown> =>
          typeof m === "object" && m !== null && !Array.isArray(m),
      );
      cachedBundledModels = models;
      return models;
    }
  } catch {
    // Non-fatal: command might not exist or might fail in test harnesses
  }

  return [];
}

/** Reset the cached bundled models (for tests). */
export function clearCachedBundledCodexModels(): void {
  cachedBundledModels = null;
}

export interface BuildCodexCatalogOptions {
  gatewayModels: unknown[];
  bundledModels?: unknown[];
}

/**
 * Build a merged model catalog combining bundled models and Gateway-discovered models.
 * Gateway models take precedence on slug collision and have their full context window preserved.
 * Bundled models with higher `max_context_window` (such as `gpt-5.4` at 1M) have their `context_window`
 * expanded so they are not constrained to the 272k default.
 */
export function buildCodexCatalog(options: BuildCodexCatalogOptions): {
  models: Array<Record<string, unknown>>;
} {
  const bundled = options.bundledModels ?? [];
  const baseTemplate =
    (bundled.find((m): m is Record<string, unknown> => typeof m === "object" && m !== null) as
      | Record<string, unknown>
      | undefined) ?? DEFAULT_CODEX_MODEL_TEMPLATE;

  const modelMap = new Map<string, Record<string, unknown>>();

  for (const raw of bundled) {
    const normalized = normalizeCodexCatalogModel(raw, baseTemplate);
    if (!normalized || typeof normalized.slug !== "string") continue;
    modelMap.set(normalized.slug, normalized);
  }

  for (const raw of options.gatewayModels) {
    const normalized = normalizeCodexCatalogModel(raw, baseTemplate);
    if (!normalized || typeof normalized.slug !== "string") continue;
    modelMap.set(normalized.slug, normalized);
  }

  return { models: Array.from(modelMap.values()) };
}

/**
 * Atomically writes a Codex model catalog JSON file into the specified directory.
 */
export function writeCodexCatalogJsonFile(options: {
  catalog: { models: unknown[] };
  paseoHome?: string;
}): string {
  const home = options.paseoHome ?? resolvePaseoHome();
  const filePath = path.join(home, CODEX_MODEL_CATALOG_FILENAME);
  fs.mkdirSync(home, { recursive: true });

  const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tempPath, JSON.stringify(options.catalog, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);

  return filePath;
}

/**
 * Returns the path to the Codex model catalog file if it exists, is non-empty,
 * and every model entry satisfies the shapes Codex requires (`visibility` as a
 * string, `description` on each reasoning level). Stale files written before
 * gateway-shape normalization fail app-server startup with `exited with code 1`,
 * so they are treated as absent here and rebuilt on the next Gateway refresh.
 */
export function resolveCodexModelCatalogPath(options?: {
  paseoHome?: string;
  env?: NodeJS.ProcessEnv;
}): string | null {
  const home = options?.paseoHome ?? resolvePaseoHome(options?.env);
  const target = path.join(home, CODEX_MODEL_CATALOG_FILENAME);
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size === 0) {
      return null;
    }
  } catch {
    // Missing or unreadable
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as {
      models?: unknown;
    };
    if (!parsed || !Array.isArray(parsed.models)) return null;
    for (const model of parsed.models) {
      if (!isValidCatalogModel(model)) return null;
    }
  } catch {
    return null;
  }
  return target;
}
