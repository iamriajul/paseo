import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentModelDefinition, AgentSelectOption } from "../../agent-sdk-types.js";
import type { ModelsDevCandidate, ModelsDevLookupResult } from "../../../models-dev/catalog.js";

import { type CliproxyAnthropicModelRow } from "../../gateway/models.js";
import { normalizeClaudeRuntimeModelId } from "./model-manifest.js";

export interface CliproxyAnthropicEnvironment {
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
}

export interface ResolveCliproxyAnthropicCredentialsOptions {
  env?: CliproxyAnthropicEnvironment;
  configDir?: string;
  readSettingsEnv?: () => Promise<CliproxyAnthropicEnvironment>;
}

export interface CliproxyAnthropicCredentials {
  baseUrl: string;
  token: string;
}

export type CliproxyAgentModelDefinition = AgentModelDefinition;

export interface CliproxyAdditionalModelLimits {
  id: string;
  label?: string;
  contextWindowMaxTokens?: number;
  maxOutputTokens?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  capabilities?: string[];
}

export interface AppendCliproxyModelsResult {
  models: CliproxyAgentModelDefinition[];
  /** Limits to merge into additionalModels (trusted CPA or single models.dev hit). */
  autoPersist: CliproxyAdditionalModelLimits[];
}

export interface AppendCliproxyModelsOptions {
  baseModels: readonly AgentModelDefinition[];
  rows: readonly CliproxyAnthropicModelRow[];
  existingAdditionalModels: readonly CliproxyAdditionalModelLimits[];
  lookupModelsDev: (modelId: string) => Promise<ModelsDevLookupResult>;
  getCustomThinkingOptions: () => AgentSelectOption[];
}

export async function resolveCliproxyAnthropicCredentials(
  options: ResolveCliproxyAnthropicCredentialsOptions = {},
): Promise<CliproxyAnthropicCredentials | null> {
  const env = options.env ?? process.env;
  const envBaseUrl = trimNonEmpty(env.ANTHROPIC_BASE_URL);
  const envToken = trimNonEmpty(env.ANTHROPIC_AUTH_TOKEN);

  let settingsEnv: CliproxyAnthropicEnvironment = {};
  if (!envBaseUrl || !envToken) {
    const readSettingsEnv =
      options.readSettingsEnv ?? (() => readCliproxySettingsEnv(options.configDir));
    try {
      settingsEnv = await readSettingsEnv();
    } catch {
      settingsEnv = {};
    }
  }

  const baseUrl = envBaseUrl ?? trimNonEmpty(settingsEnv.ANTHROPIC_BASE_URL);
  const token = envToken ?? trimNonEmpty(settingsEnv.ANTHROPIC_AUTH_TOKEN);
  if (!baseUrl || !token) return null;

  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  if (!normalizedBaseUrl) return null;

  return { baseUrl: normalizedBaseUrl, token };
}

async function readCliproxySettingsEnv(configDir?: string): Promise<CliproxyAnthropicEnvironment> {
  const resolvedConfigDir =
    configDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");

  try {
    const rawSettings = await fs.readFile(path.join(resolvedConfigDir, "settings.json"), "utf8");
    const parsed: unknown = JSON.parse(rawSettings);
    if (!isRecord(parsed) || !isRecord(parsed.env)) return {};

    return {
      ANTHROPIC_BASE_URL: readString(parsed.env.ANTHROPIC_BASE_URL),
      ANTHROPIC_AUTH_TOKEN: readString(parsed.env.ANTHROPIC_AUTH_TOKEN),
    };
  } catch {
    return {};
  }
}

function trimNonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function appendCliproxyModelsToClaudeCatalog(
  options: AppendCliproxyModelsOptions,
): Promise<AppendCliproxyModelsResult> {
  const existingIds = new Set(options.baseModels.map((model) => model.id));
  const additions: CliproxyAgentModelDefinition[] = [];
  const overlays = new Map<string, CliproxyModelCapacity>();
  const autoPersist: CliproxyAdditionalModelLimits[] = [];

  for (const row of options.rows) {
    // Manifest owns these: 200k base, separate [1m] variant, Opus 5.5 always 1M.
    // CPA reports the base id as 1M, which would collapse that pair.
    if (normalizeClaudeRuntimeModelId(row.id)) continue;
    const capacity = await resolveCliproxyModelCapacity(row, {
      existingAdditionalModels: options.existingAdditionalModels,
      lookupModelsDev: options.lookupModelsDev,
    });
    if (capacity.autoPersist) autoPersist.push(capacity.autoPersist);
    if (existingIds.has(row.id)) {
      overlays.set(row.id, capacity);
      continue;
    }
    existingIds.add(row.id);
    additions.push(
      mapCliproxyModelRowToAgentModel(row, capacity, options.getCustomThinkingOptions()),
    );
  }

  return {
    models: applyCliproxyCapacityOverlays(
      mergeCliproxyModels(options.baseModels, additions),
      overlays,
    ),
    autoPersist,
  };
}

interface CliproxyModelCapacity {
  contextWindowMaxTokens?: number;
  maxOutputTokens?: number;
  needsCapacityConfig?: true;
  modelsDevCandidates?: ModelsDevCandidate[];
  autoPersist?: CliproxyAdditionalModelLimits;
}

interface CliproxyCapacityLookupOptions {
  existingAdditionalModels: readonly CliproxyAdditionalModelLimits[];
  lookupModelsDev: (modelId: string) => Promise<ModelsDevLookupResult>;
}

function configuredModalitiesMissing(
  configured: CliproxyAdditionalModelLimits | undefined,
): boolean {
  return (
    nonEmptyStringList(configured?.inputModalities) === undefined ||
    nonEmptyStringList(configured?.outputModalities) === undefined ||
    nonEmptyStringList(configured?.capabilities) === undefined
  );
}

async function fillCapacityFromModelsDev(
  modelId: string,
  lookupModelsDev: (modelId: string) => Promise<ModelsDevLookupResult>,
  target: {
    fillContextWindow: (value: number | undefined) => void;
    fillMaxOutput: (value: number | undefined) => void;
    fillModalities: (
      key: "inputModalities" | "outputModalities" | "capabilities",
      value: readonly string[] | undefined,
    ) => void;
    contextWindowMissing: () => boolean;
    setCandidates: (candidates: ModelsDevCandidate[]) => void;
  },
): Promise<void> {
  try {
    const lookup = await lookupModelsDev(modelId);
    if (lookup.found && lookup.candidates.length === 1) {
      const candidate = lookup.candidates[0];
      target.fillContextWindow(positiveCapacityValue(candidate.contextWindowMaxTokens));
      target.fillMaxOutput(positiveCapacityValue(candidate.maxOutputTokens));
      target.fillModalities("inputModalities", candidate.inputModalities);
      target.fillModalities("outputModalities", candidate.outputModalities);
      target.fillModalities("capabilities", candidate.capabilities);
      return;
    }
    if (target.contextWindowMissing() && lookup.found && lookup.candidates.length > 1) {
      target.setCandidates(lookup.candidates);
    }
  } catch {
    // Keep configured/trusted values and mark unresolved context below.
  }
}

async function resolveCliproxyModelCapacity(
  row: CliproxyAnthropicModelRow,
  options: CliproxyCapacityLookupOptions,
): Promise<CliproxyModelCapacity> {
  const configured = options.existingAdditionalModels.find((model) => model.id === row.id);
  let contextWindowMaxTokens = positiveCapacityValue(configured?.contextWindowMaxTokens);
  let maxOutputTokens = positiveCapacityValue(configured?.maxOutputTokens);
  let autoPersist: CliproxyAdditionalModelLimits | undefined;
  let modelsDevCandidates: ModelsDevCandidate[] | undefined;

  const fillContextWindow = (value: number | undefined): void => {
    if (contextWindowMaxTokens !== undefined || value === undefined) return;
    contextWindowMaxTokens = value;
    autoPersist ??= { id: row.id };
    autoPersist.contextWindowMaxTokens = value;
  };
  const fillMaxOutput = (value: number | undefined): void => {
    if (maxOutputTokens !== undefined || value === undefined) return;
    maxOutputTokens = value;
    autoPersist ??= { id: row.id };
    autoPersist.maxOutputTokens = value;
  };
  const fillModalities = (
    key: "inputModalities" | "outputModalities" | "capabilities",
    value: readonly string[] | undefined,
  ): void => {
    if (!value || value.length === 0) return;
    if (nonEmptyStringList(configured?.[key]) !== undefined) return;
    autoPersist ??= { id: row.id };
    if (autoPersist[key] !== undefined) return;
    autoPersist[key] = [...value];
  };

  // CPA's advertised window is the launch contract, same as Codex and OMP.
  // models.dev fills omitted windows and modalities; it never replaces a CPA window.
  fillContextWindow(positiveCapacityValue(row.maxInputTokens));
  fillMaxOutput(positiveCapacityValue(row.maxOutputTokens));

  const modalitiesMissing = configuredModalitiesMissing(configured);
  if (contextWindowMaxTokens === undefined || maxOutputTokens === undefined || modalitiesMissing) {
    await fillCapacityFromModelsDev(row.id, options.lookupModelsDev, {
      fillContextWindow,
      fillMaxOutput,
      fillModalities,
      contextWindowMissing: () => contextWindowMaxTokens === undefined,
      setCandidates: (candidates) => {
        modelsDevCandidates = candidates;
      },
    });
  }

  return {
    ...(contextWindowMaxTokens === undefined ? {} : { contextWindowMaxTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(contextWindowMaxTokens === undefined
      ? {
          needsCapacityConfig: true,
          ...(modelsDevCandidates ? { modelsDevCandidates } : {}),
        }
      : {}),
    ...(autoPersist ? { autoPersist } : {}),
  };
}

function mapCliproxyModelRowToAgentModel(
  row: CliproxyAnthropicModelRow,
  capacity: CliproxyModelCapacity,
  thinkingOptions: AgentSelectOption[],
): CliproxyAgentModelDefinition {
  const label = row.label || row.id;
  const metadata = {
    source: "cliproxyapi",
    ownedBy: row.ownedBy,
    ...(capacity.needsCapacityConfig === true ? { needsCapacityConfig: true } : {}),
    ...(capacity.modelsDevCandidates ? { modelsDevCandidates: capacity.modelsDevCandidates } : {}),
  };

  return {
    provider: "claude",
    id: row.id,
    label,
    description: row.label && row.label !== row.id ? row.label : undefined,
    thinkingOptions,
    metadata,
    ...(capacity.contextWindowMaxTokens === undefined
      ? {}
      : { contextWindowMaxTokens: capacity.contextWindowMaxTokens }),
    ...(capacity.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: capacity.maxOutputTokens }),
    ...(capacity.needsCapacityConfig === true ? { needsCapacityConfig: true } : {}),
    ...(capacity.modelsDevCandidates ? { modelsDevCandidates: capacity.modelsDevCandidates } : {}),
  };
}

export function mergeCliproxyModels(
  baseModels: readonly AgentModelDefinition[],
  additions: readonly CliproxyAgentModelDefinition[],
): CliproxyAgentModelDefinition[] {
  const merged = [...baseModels] as CliproxyAgentModelDefinition[];
  const seenIds = new Set(baseModels.map((model) => model.id));
  for (const addition of additions) {
    if (seenIds.has(addition.id)) continue;
    seenIds.add(addition.id);
    merged.push(addition);
  }
  return merged;
}

function applyCliproxyCapacityOverlays(
  models: readonly CliproxyAgentModelDefinition[],
  overlays: ReadonlyMap<string, CliproxyModelCapacity>,
): CliproxyAgentModelDefinition[] {
  if (overlays.size === 0) return [...models];
  return models.map((model) => {
    const capacity = overlays.get(model.id);
    if (!capacity) return model;
    const next: CliproxyAgentModelDefinition = {
      ...model,
      ...(capacity.contextWindowMaxTokens === undefined
        ? {}
        : { contextWindowMaxTokens: capacity.contextWindowMaxTokens }),
      ...(capacity.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: capacity.maxOutputTokens }),
    };
    if (capacity.contextWindowMaxTokens !== undefined) {
      delete next.needsCapacityConfig;
    } else if (capacity.needsCapacityConfig === true) {
      next.needsCapacityConfig = true;
    }
    return next;
  });
}

export function mergeAdditionalModelLimits(
  existingModels: readonly CliproxyAdditionalModelLimits[],
  updates: readonly CliproxyAdditionalModelLimits[],
): CliproxyAdditionalModelLimits[] {
  let merged: CliproxyAdditionalModelLimits[] | undefined;
  const byId = new Map(existingModels.map((model) => [model.id, model]));

  const cloneExisting = (): CliproxyAdditionalModelLimits[] => {
    if (merged) return merged;
    merged = existingModels.map((model) => ({ ...model }));
    for (const model of merged) {
      byId.set(model.id, model);
    }
    return merged;
  };

  for (const update of updates) {
    const existing = byId.get(update.id);
    if (!existing) {
      const added = buildAddedModelLimits(update);
      cloneExisting().push(added);
      byId.set(added.id, added);
      continue;
    }
    if (!modelLimitsUpdateFills(existing, update)) continue;
    const target = cloneExisting().find((model) => model.id === update.id);
    if (!target) continue;
    applyModelLimitsUpdate(target, update);
  }

  return merged ?? (existingModels as CliproxyAdditionalModelLimits[]);
}

function buildAddedModelLimits(
  update: CliproxyAdditionalModelLimits,
): CliproxyAdditionalModelLimits {
  const contextWindowMaxTokens = positiveCapacityValue(update.contextWindowMaxTokens);
  const maxOutputTokens = positiveCapacityValue(update.maxOutputTokens);
  const inputModalities = nonEmptyStringList(update.inputModalities);
  const outputModalities = nonEmptyStringList(update.outputModalities);
  const capabilities = nonEmptyStringList(update.capabilities);
  return {
    id: update.id,
    ...(update.label ? { label: update.label } : {}),
    ...(contextWindowMaxTokens === undefined ? {} : { contextWindowMaxTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(inputModalities === undefined ? {} : { inputModalities }),
    ...(outputModalities === undefined ? {} : { outputModalities }),
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

function modelLimitsUpdateFills(
  existing: CliproxyAdditionalModelLimits,
  update: CliproxyAdditionalModelLimits,
): boolean {
  if (!existing.label && update.label) return true;
  if (
    positiveCapacityValue(existing.contextWindowMaxTokens) === undefined &&
    positiveCapacityValue(update.contextWindowMaxTokens) !== undefined
  ) {
    return true;
  }
  if (
    positiveCapacityValue(existing.maxOutputTokens) === undefined &&
    positiveCapacityValue(update.maxOutputTokens) !== undefined
  ) {
    return true;
  }
  if (
    nonEmptyStringList(existing.inputModalities) === undefined &&
    nonEmptyStringList(update.inputModalities) !== undefined
  ) {
    return true;
  }
  if (
    nonEmptyStringList(existing.outputModalities) === undefined &&
    nonEmptyStringList(update.outputModalities) !== undefined
  ) {
    return true;
  }
  return (
    nonEmptyStringList(existing.capabilities) === undefined &&
    nonEmptyStringList(update.capabilities) !== undefined
  );
}

function applyModelLimitsUpdate(
  target: CliproxyAdditionalModelLimits,
  update: CliproxyAdditionalModelLimits,
): void {
  if (!target.label && update.label) target.label = update.label;
  const contextWindowMaxTokens = positiveCapacityValue(update.contextWindowMaxTokens);
  if (
    positiveCapacityValue(target.contextWindowMaxTokens) === undefined &&
    contextWindowMaxTokens !== undefined
  ) {
    target.contextWindowMaxTokens = contextWindowMaxTokens;
  }
  const maxOutputTokens = positiveCapacityValue(update.maxOutputTokens);
  if (
    positiveCapacityValue(target.maxOutputTokens) === undefined &&
    maxOutputTokens !== undefined
  ) {
    target.maxOutputTokens = maxOutputTokens;
  }
  const inputModalities = nonEmptyStringList(update.inputModalities);
  if (nonEmptyStringList(target.inputModalities) === undefined && inputModalities !== undefined) {
    target.inputModalities = inputModalities;
  }
  const outputModalities = nonEmptyStringList(update.outputModalities);
  if (nonEmptyStringList(target.outputModalities) === undefined && outputModalities !== undefined) {
    target.outputModalities = outputModalities;
  }
  const capabilities = nonEmptyStringList(update.capabilities);
  if (nonEmptyStringList(target.capabilities) === undefined && capabilities !== undefined) {
    target.capabilities = capabilities;
  }
}

export const mergeCliproxyAdditionalModelLimits = mergeAdditionalModelLimits;

function positiveCapacityValue(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonEmptyStringList(value: readonly string[] | undefined): string[] | undefined {
  if (!value || value.length === 0) return undefined;
  return [...value];
}
