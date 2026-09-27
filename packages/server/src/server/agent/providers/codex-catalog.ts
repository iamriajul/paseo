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

/**
 * Normalizes a raw model record to ensure it contains all required fields of
 * Codex's `ModelInfo` serde struct, setting `context_window` and `max_context_window`
 * to the full advertised capacity and enabling 100% effective context window for 1M+ models.
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

  return {
    ...baseTemplate,
    ...record,
    slug,
    display_name: displayName,
    context_window: contextWindow,
    max_context_window: maxContextWindow,
    effective_context_window_percent: effectivePercent,
    shell_type: typeof record.shell_type === "string" ? record.shell_type : baseTemplate.shell_type,
    visibility: record.visibility ?? baseTemplate.visibility,
    supported_in_api:
      record.supported_in_api !== undefined
        ? record.supported_in_api
        : baseTemplate.supported_in_api,
    priority: typeof record.priority === "number" ? record.priority : baseTemplate.priority,
    supported_reasoning_levels: Array.isArray(record.supported_reasoning_levels)
      ? record.supported_reasoning_levels
      : (baseTemplate.supported_reasoning_levels ?? []),
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
 * Returns the path to the Codex model catalog file if it exists and is non-empty.
 */
export function resolveCodexModelCatalogPath(options?: {
  paseoHome?: string;
  env?: NodeJS.ProcessEnv;
}): string | null {
  const home = options?.paseoHome ?? resolvePaseoHome(options?.env);
  const target = path.join(home, CODEX_MODEL_CATALOG_FILENAME);
  try {
    const stat = fs.statSync(target);
    if (stat.isFile() && stat.size > 0) {
      return target;
    }
  } catch {
    // Missing or unreadable
  }
  return null;
}
