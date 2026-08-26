import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Logger } from "pino";

import type { AgentModelDefinition } from "../../agent-sdk-types.js";
import {
  getClaudeCustomModelThinkingOptions,
  getClaudeManifestModels,
  normalizeClaudeManifestModelId,
  normalizeClaudeRuntimeModelId as normalizeClaudeManifestRuntimeModelId,
} from "./model-manifest.js";

const CLAUDE_SETTINGS_MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
] as const;

export const CLAUDE_CUSTOM_MODEL_PIN_ENV_KEYS = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;

export type ClaudeCustomModelPinEnvKey = (typeof CLAUDE_CUSTOM_MODEL_PIN_ENV_KEYS)[number];

const CLAUDE_FAMILY_ALIASES = new Set(["opus", "sonnet", "haiku", "fable"]);

export function getClaudeModels(claudeCodeVersion?: string): AgentModelDefinition[] {
  return getClaudeManifestModels(claudeCodeVersion);
}

export function resolveConfiguredClaudeModel(model: AgentModelDefinition): AgentModelDefinition {
  if (model.thinkingOptions !== undefined) return model;

  const manifestModelId = normalizeClaudeManifestModelId(model.id);
  const manifestModel = manifestModelId
    ? getClaudeModels().find((candidate) => candidate.id === manifestModelId)
    : undefined;
  if (manifestModel) {
    return manifestModel.thinkingOptions
      ? { ...model, thinkingOptions: manifestModel.thinkingOptions }
      : model;
  }
  return { ...model, thinkingOptions: getClaudeCustomModelThinkingOptions() };
}

export function findClaudeModel(
  modelId: string | null | undefined,
): AgentModelDefinition | undefined {
  const normalizedModelId = normalizeClaudeRuntimeModelId(modelId);
  if (!normalizedModelId) {
    return undefined;
  }
  return getClaudeModels().find((model) => model.id === normalizedModelId);
}

export async function getClaudeModelsWithSettings(
  logger: Logger,
  configDir?: string,
  claudeCodeVersion?: string,
): Promise<AgentModelDefinition[]> {
  const hardcodedModels = getClaudeModels(claudeCodeVersion);
  const settingsModels = await readClaudeSettingsModels(logger, configDir);
  if (settingsModels.length === 0) {
    return hardcodedModels;
  }

  const models = [...hardcodedModels];

  for (const model of settingsModels) {
    const existingIndex = models.findIndex((candidate) => candidate.id === model.id);
    if (existingIndex !== -1) {
      const existing = models[existingIndex];
      if (existing?.isSelectable === false) {
        models[existingIndex] = { ...existing, ...model, isSelectable: true };
      }
      continue;
    }
    models.push(model);
  }

  return models;
}

async function readClaudeSettingsModels(
  logger: Logger,
  configDir?: string,
): Promise<AgentModelDefinition[]> {
  const settingsPath = path.join(resolveClaudeConfigDir(configDir), "settings.json");

  let parsed: unknown;
  try {
    const rawSettings = await fs.readFile(settingsPath, "utf8");
    parsed = JSON.parse(rawSettings);
  } catch (error) {
    logger.debug({ err: error, settingsPath }, "Failed to read Claude settings models");
    return [];
  }

  if (!isRecord(parsed)) {
    logger.debug({ settingsPath }, "Claude settings.json is not an object");
    return [];
  }

  const models: AgentModelDefinition[] = [];
  addSettingsModel(models, parsed.model, "model");

  const env = parsed.env;
  if (env === undefined) {
    return models;
  }
  if (!isRecord(env)) {
    logger.debug({ settingsPath }, "Claude settings.json env is not an object");
    return models;
  }

  for (const envKey of CLAUDE_SETTINGS_MODEL_ENV_KEYS) {
    addSettingsModel(models, env[envKey], `env.${envKey}`);
  }

  return models;
}

function resolveClaudeConfigDir(configDir?: string): string {
  return configDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

function addSettingsModel(
  models: AgentModelDefinition[],
  value: unknown,
  settingsKey: string,
): void {
  if (typeof value !== "string") {
    return;
  }

  const id = value.trim();
  if (id.length === 0 || models.some((model) => model.id === id)) {
    return;
  }

  models.push({
    provider: "claude",
    id,
    label: id,
    description: `From Claude settings.json ${settingsKey}`,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a runtime model string (from SDK init message) to a known model ID.
 * Handles the `[1m]` suffix that the SDK appends for 1M context sessions.
 */
export function normalizeClaudeRuntimeModelId(value: string | null | undefined): string | null {
  return normalizeClaudeManifestRuntimeModelId(value);
}

/**
 * True when the selected model is a custom non-family ID that should pin Claude Code
 * family-alias / subagent env vars to itself.
 */
export function isClaudeCustomNonFamilyModel(modelId: string | null | undefined): boolean {
  const trimmed = typeof modelId === "string" ? modelId.trim() : "";
  if (!trimmed) {
    return false;
  }
  if (CLAUDE_FAMILY_ALIASES.has(trimmed.toLowerCase())) {
    return false;
  }
  // First-party catalog IDs and gateway-prefixed first-party forms normalize to a manifest ID.
  if (normalizeClaudeRuntimeModelId(trimmed)) {
    return false;
  }
  return true;
}

export function buildClaudeCustomModelEnvPins(
  modelId: string,
): Record<ClaudeCustomModelPinEnvKey, string> {
  const pins = {} as Record<ClaudeCustomModelPinEnvKey, string>;
  for (const key of CLAUDE_CUSTOM_MODEL_PIN_ENV_KEYS) {
    pins[key] = modelId;
  }
  return pins;
}

function hasNonEmptyEnvValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Fill missing Claude family/subagent pin env keys from a custom non-family selected model.
 * User-provided non-empty values are preserved. First-party/family models are a no-op.
 */
export function applyClaudeCustomModelEnvPins(
  env: NodeJS.ProcessEnv,
  modelId: string | null | undefined,
): NodeJS.ProcessEnv {
  if (!isClaudeCustomNonFamilyModel(modelId)) {
    return env;
  }
  const selectedModel = (modelId as string).trim();
  const pins = buildClaudeCustomModelEnvPins(selectedModel);
  let changed = false;
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of CLAUDE_CUSTOM_MODEL_PIN_ENV_KEYS) {
    if (hasNonEmptyEnvValue(next[key])) {
      continue;
    }
    next[key] = pins[key];
    changed = true;
  }
  return changed ? next : env;
}

export const CLAUDE_MAX_CONTEXT_TOKENS_ENV_KEY = "CLAUDE_CODE_MAX_CONTEXT_TOKENS";
export const CLAUDE_MAX_OUTPUT_TOKENS_ENV_KEY = "CLAUDE_CODE_MAX_OUTPUT_TOKENS";
export const CLAUDE_AUTO_COMPACT_WINDOW_ENV_KEY = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";

export const CLAUDE_AUTO_COMPACT_THRESHOLD_PERCENT_MIN = 50;
export const CLAUDE_AUTO_COMPACT_THRESHOLD_PERCENT_MAX = 99;
export const CLAUDE_AUTO_COMPACT_THRESHOLD_PERCENT_DEFAULT = 90;

interface ClaudeProfileModelLimits {
  id: string;
  contextWindowMaxTokens?: number;
  maxOutputTokens?: number;
  autoCompactThresholdPercent?: number;
}

/**
 * Resolve the preferred context-window max for a selected Claude model.
 * Configured profile/additional model windows win over first-party catalog defaults.
 */
export function resolveClaudeContextWindowMaxTokens(options: {
  modelId: string | null | undefined;
  profileModels?: ClaudeProfileModelLimits[];
}): number | undefined {
  const profileMatch = findProfileModel(options.modelId, options.profileModels);
  if (
    typeof profileMatch?.contextWindowMaxTokens === "number" &&
    Number.isFinite(profileMatch.contextWindowMaxTokens) &&
    profileMatch.contextWindowMaxTokens > 0
  ) {
    return Math.trunc(profileMatch.contextWindowMaxTokens);
  }

  const trimmed = typeof options.modelId === "string" ? options.modelId.trim() : "";
  if (!trimmed) {
    return undefined;
  }
  return findClaudeModel(trimmed)?.contextWindowMaxTokens;
}

/**
 * Resolve the preferred max-output tokens for a selected Claude model.
 * Only profile/additional model config is used; first-party models keep Claude Code defaults.
 */
export function resolveClaudeMaxOutputTokens(options: {
  modelId: string | null | undefined;
  profileModels?: ClaudeProfileModelLimits[];
}): number | undefined {
  const profileMatch = findProfileModel(options.modelId, options.profileModels);
  if (
    typeof profileMatch?.maxOutputTokens === "number" &&
    Number.isFinite(profileMatch.maxOutputTokens) &&
    profileMatch.maxOutputTokens > 0
  ) {
    return Math.trunc(profileMatch.maxOutputTokens);
  }
  return undefined;
}

/**
 * Apply CLAUDE_CODE_MAX_CONTEXT_TOKENS from a configured context window.
 * Fill-if-missing by default; pass `{ overwrite: true }` when a profile/additional
 * model owns the window so ambient host env cannot keep a 200k assumed limit.
 */
export function applyClaudeMaxContextTokensEnv(
  env: NodeJS.ProcessEnv,
  contextWindowMaxTokens: number | undefined,
  options?: { overwrite?: boolean },
): NodeJS.ProcessEnv {
  return applyPositiveTokenEnv(
    env,
    CLAUDE_MAX_CONTEXT_TOKENS_ENV_KEY,
    contextWindowMaxTokens,
    options,
  );
}

/**
 * Fill-if-missing CLAUDE_CODE_MAX_OUTPUT_TOKENS from a configured max output.
 * Leave unset when unknown so Claude Code keeps its custom-model default.
 */
export function applyClaudeMaxOutputTokensEnv(
  env: NodeJS.ProcessEnv,
  maxOutputTokens: number | undefined,
  options?: { overwrite?: boolean },
): NodeJS.ProcessEnv {
  return applyPositiveTokenEnv(env, CLAUDE_MAX_OUTPUT_TOKENS_ENV_KEY, maxOutputTokens, options);
}

/**
 * Clamp a configured auto-compact threshold percent into the supported range.
 * Missing or invalid values fall back to the default.
 */
export function normalizeClaudeAutoCompactThresholdPercent(percent: number | undefined): number {
  if (
    typeof percent !== "number" ||
    !Number.isFinite(percent) ||
    percent < CLAUDE_AUTO_COMPACT_THRESHOLD_PERCENT_MIN ||
    percent > CLAUDE_AUTO_COMPACT_THRESHOLD_PERCENT_MAX
  ) {
    return CLAUDE_AUTO_COMPACT_THRESHOLD_PERCENT_DEFAULT;
  }
  return Math.trunc(percent);
}

/**
 * Compute CLAUDE_CODE_AUTO_COMPACT_WINDOW from a profile context window + percent.
 * Only profile-configured context windows participate (not first-party catalog defaults).
 */
export function resolveClaudeAutoCompactWindowTokens(options: {
  modelId: string | null | undefined;
  profileModels?: ClaudeProfileModelLimits[];
}): number | undefined {
  const profileMatch = findProfileModel(options.modelId, options.profileModels);
  const contextWindowMaxTokens = profileMatch?.contextWindowMaxTokens;
  if (
    typeof contextWindowMaxTokens !== "number" ||
    !Number.isFinite(contextWindowMaxTokens) ||
    contextWindowMaxTokens <= 0
  ) {
    return undefined;
  }
  const percent = normalizeClaudeAutoCompactThresholdPercent(
    profileMatch?.autoCompactThresholdPercent,
  );
  const windowTokens = Math.floor((Math.trunc(contextWindowMaxTokens) * percent) / 100);
  return windowTokens > 0 ? windowTokens : undefined;
}

/**
 * Fill-if-missing CLAUDE_CODE_AUTO_COMPACT_WINDOW from profile capacity settings.
 * Leaves Claude Code's own threshold math alone when no profile context window is set.
 */
export function applyClaudeAutoCompactWindowEnv(
  env: NodeJS.ProcessEnv,
  autoCompactWindowTokens: number | undefined,
  options?: { overwrite?: boolean },
): NodeJS.ProcessEnv {
  return applyPositiveTokenEnv(
    env,
    CLAUDE_AUTO_COMPACT_WINDOW_ENV_KEY,
    autoCompactWindowTokens,
    options,
  );
}

/**
 * Claude Code reports an assumed window (often 200K) for unrecognized custom model IDs.
 * Never shrink a configured profile window to that guess; still allow a larger reported
 * window (first-party 1M sessions).
 */
export function preferConfiguredClaudeContextWindow(
  configured: number | undefined,
  reported: number | undefined,
): number | undefined {
  const configuredTokens = positiveTokenCount(configured);
  const reportedTokens = positiveTokenCount(reported);
  if (configuredTokens === undefined) {
    return reportedTokens;
  }
  if (reportedTokens === undefined) {
    return configuredTokens;
  }
  return Math.max(configuredTokens, reportedTokens);
}

function positiveTokenCount(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.trunc(value);
}

function profileModelIdTail(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}

function profileModelIdsMatch(selected: string, candidate: string): boolean {
  if (selected === candidate) {
    return true;
  }
  const selectedLower = selected.toLowerCase();
  const candidateLower = candidate.toLowerCase();
  if (selectedLower === candidateLower) {
    return true;
  }
  return profileModelIdTail(selectedLower) === profileModelIdTail(candidateLower);
}

function findProfileModel(
  modelId: string | null | undefined,
  profileModels: ClaudeProfileModelLimits[] | undefined,
): ClaudeProfileModelLimits | undefined {
  const trimmed = typeof modelId === "string" ? modelId.trim() : "";
  if (!trimmed || !profileModels || profileModels.length === 0) {
    return undefined;
  }
  return (
    profileModels.find((model) => model.id === trimmed) ??
    profileModels.find((model) => profileModelIdsMatch(trimmed, model.id))
  );
}

function applyPositiveTokenEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  value: number | undefined,
  options?: { overwrite?: boolean },
): NodeJS.ProcessEnv {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return env;
  }
  if (!options?.overwrite && hasNonEmptyEnvValue(env[key])) {
    return env;
  }
  return {
    ...env,
    [key]: String(Math.trunc(value)),
  };
}

/**
 * Placeholder model values Claude Code writes on frames with no real inference behind them.
 * These are not models and must never be displayed.
 */
const CLAUDE_PLACEHOLDER_MODEL_IDS = new Set(["<synthetic>"]);

/**
 * Resolve a model id observed on a Claude assistant frame, for display.
 *
 * Prefers the manifest-normalized id so equivalent spellings collapse (a dated alias and a
 * gateway prefix are the same model), but falls back to the raw string when the manifest does
 * not know it. The fallback matters: Claude Code is an Anthropic-compatible client, so subagents
 * routinely report models that are not Anthropic's — Z.AI GLM ids via `ANTHROPIC_BASE_URL`
 * (docs/custom-providers.md) among them. Manifest-only resolution would blank the model for
 * exactly those users.
 *
 * A `[1m]` suffix is preserved where it names its own manifest entry. Models such as Fable 5
 * that only have a 1M entry normalize the retired suffixed spelling to the canonical ID.
 *
 * Returns null for placeholders and empty values, meaning "not observed".
 */
export function resolveObservedClaudeModelId(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || CLAUDE_PLACEHOLDER_MODEL_IDS.has(trimmed)) {
    return null;
  }
  return normalizeClaudeManifestRuntimeModelId(trimmed) ?? trimmed;
}
