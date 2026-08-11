import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentModelDefinition, AgentSelectOption } from "../../agent-sdk-types.js";
import type { ModelsDevCandidate, ModelsDevLookupResult } from "../../../models-dev/catalog.js";

// cliproxy-models.ts — decode mirrors CLIProxyAPI internal/util/claude_model.go
export const CLAUDE_DD_MODEL_PREFIX = "claude-fable-5-dd-";

export const OFFICIAL_CPA_OWNERS = new Set([
  "anthropic",
  "openai",
  "codex",
  "xai",
  "x-ai",
  "grok",
  "gemini",
  "google",
  "vertex",
  "aistudio",
  "antigravity",
  "kimi",
  "moonshot",
]);

export const CLIPROXY_MODELS_MAX_PAGES = 20;
export const CLIPROXY_MODELS_TIMEOUT_MS = 8_000;

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

export interface CliproxyAnthropicModelRow {
  id: string;
  label: string;
  ownedBy: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  rawListId: string;
}

export type CliproxyAgentModelDefinition = AgentModelDefinition;

export interface CliproxyAdditionalModelLimits {
  id: string;
  label?: string;
  contextWindowMaxTokens?: number;
  maxOutputTokens?: number;
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

export interface FetchCliproxyAnthropicModelsOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
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

export function responseHasCpaFingerprint(headers: Headers): boolean {
  for (const name of headers.keys()) {
    if (/^x-cpa-/i.test(name)) return true;
  }
  return false;
}

export async function fetchCliproxyAnthropicModels(
  options: FetchCliproxyAnthropicModelsOptions,
): Promise<CliproxyAnthropicModelRow[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const rows: CliproxyAnthropicModelRow[] = [];
  const seenIds = new Set<string>();
  const headers = {
    Authorization: `Bearer ${options.token}`,
    "Anthropic-Version": "2023-06-01",
    "User-Agent": "claude-cli/paseo",
  };

  let afterId: string | undefined;
  let pages = 0;

  while (pages < CLIPROXY_MODELS_MAX_PAGES) {
    const url = buildCliproxyModelsUrl(options.baseUrl, afterId);
    if (!url) return rows;

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(CLIPROXY_MODELS_TIMEOUT_MS),
      });
    } catch {
      return rows;
    }
    pages += 1;

    if (!response.ok) return rows;
    if (pages === 1 && !responseHasCpaFingerprint(response.headers)) return [];

    let page: CliproxyAnthropicModelsPage;
    try {
      const payload: unknown = await response.json();
      page = parseCliproxyAnthropicModelsPage(payload);
    } catch {
      return rows;
    }

    let addedDecodedIds = 0;
    for (const value of page.data) {
      const decodedModel = decodeCliproxyAnthropicModel(value);
      if (!decodedModel || seenIds.has(decodedModel.id)) continue;
      seenIds.add(decodedModel.id);
      addedDecodedIds += 1;

      const row = mapCliproxyAnthropicModelRow(value, decodedModel);
      if (row) rows.push(row);
    }

    if (
      !page.hasMore ||
      !page.lastId ||
      pages >= CLIPROXY_MODELS_MAX_PAGES ||
      addedDecodedIds === 0
    ) {
      return rows;
    }
    afterId = page.lastId;
  }

  return rows;
}

interface CliproxyAnthropicModelsPage {
  data: unknown[];
  hasMore: boolean;
  lastId: string | null;
}

interface DecodedCliproxyAnthropicModel {
  id: string;
  rawListId: string;
}

function parseCliproxyAnthropicModelsPage(payload: unknown): CliproxyAnthropicModelsPage {
  if (!isRecord(payload)) {
    return { data: [], hasMore: false, lastId: null };
  }

  const data = Array.isArray(payload.data) ? payload.data : [];
  const lastId = trimNonEmpty(payload.last_id);
  return { data, hasMore: payload.has_more === true, lastId };
}

function decodeCliproxyAnthropicModel(value: unknown): DecodedCliproxyAnthropicModel | null {
  if (!isRecord(value)) return null;

  const rawListId = trimNonEmpty(value.id);
  if (!rawListId) return null;

  const id = decodeCliproxyClaudeModelId(rawListId);
  return id ? { id, rawListId } : null;
}

function mapCliproxyAnthropicModelRow(
  value: unknown,
  decodedModel: DecodedCliproxyAnthropicModel,
): CliproxyAnthropicModelRow | null {
  if (!isRecord(value)) return null;
  if (
    isCliproxyNonChatModel({ id: decodedModel.id, displayName: readString(value.display_name) })
  ) {
    return null;
  }

  const label = trimNonEmpty(value.display_name) ?? decodedModel.id;
  const ownedBy = readString(value.owned_by)?.trim() ?? "";
  const maxInputTokens = readFiniteNumber(value.max_input_tokens);
  const maxOutputTokens = readFiniteNumber(value.max_tokens);

  return {
    id: decodedModel.id,
    label,
    ownedBy,
    ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    rawListId: decodedModel.rawListId,
  };
}

function buildCliproxyModelsUrl(baseUrl: string, afterId?: string): string | null {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  if (!normalizedBaseUrl) return null;

  try {
    const url = new URL(`${normalizedBaseUrl}/v1/models`);
    if (afterId) url.searchParams.set("after_id", afterId);
    return url.toString();
  } catch {
    return null;
  }
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

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeCliproxyClaudeModelId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return trimmed;

  const match = /^(.*)\(([^()]*)\)$/.exec(trimmed);
  const base = match?.[1] ?? trimmed;
  const suffix = match ? `(${match[2]})` : "";

  if (!base.startsWith(CLAUDE_DD_MODEL_PREFIX)) return trimmed;
  const encoded = base.slice(CLAUDE_DD_MODEL_PREFIX.length);
  if (!encoded) return trimmed;
  return [...encoded].toReversed().join("") + suffix;
}

export function isOfficialCpaOwner(ownedBy: string | null | undefined): boolean {
  if (typeof ownedBy !== "string") return false;
  return OFFICIAL_CPA_OWNERS.has(ownedBy.trim().toLowerCase());
}

export function isCliproxyNonChatModel(options: { id: string; displayName?: string }): boolean {
  const haystack = `${options.id} ${options.displayName ?? ""}`.toLowerCase();
  return (
    haystack.includes("image") ||
    haystack.includes("video") ||
    haystack.includes("gpt-image") ||
    haystack.includes("grok-imagine")
  );
}

export async function appendCliproxyModelsToClaudeCatalog(
  options: AppendCliproxyModelsOptions,
): Promise<AppendCliproxyModelsResult> {
  const existingIds = new Set(options.baseModels.map((model) => model.id));
  const additions: CliproxyAgentModelDefinition[] = [];
  const autoPersist: CliproxyAdditionalModelLimits[] = [];

  for (const row of options.rows) {
    if (existingIds.has(row.id)) continue;
    existingIds.add(row.id);

    const capacity = await resolveCliproxyModelCapacity(row, {
      existingAdditionalModels: options.existingAdditionalModels,
      lookupModelsDev: options.lookupModelsDev,
    });
    additions.push(
      mapCliproxyModelRowToAgentModel(row, capacity, options.getCustomThinkingOptions()),
    );
    if (capacity.autoPersist) autoPersist.push(capacity.autoPersist);
  }

  return {
    models: mergeCliproxyModels(options.baseModels, additions),
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
    autoPersist ??= { id: row.id, label: row.label || row.id };
    autoPersist.contextWindowMaxTokens = value;
  };
  const fillMaxOutput = (value: number | undefined): void => {
    if (maxOutputTokens !== undefined || value === undefined) return;
    maxOutputTokens = value;
    autoPersist ??= { id: row.id, label: row.label || row.id };
    autoPersist.maxOutputTokens = value;
  };

  if (isOfficialCpaOwner(row.ownedBy)) {
    fillContextWindow(positiveCapacityValue(row.maxInputTokens));
    fillMaxOutput(positiveCapacityValue(row.maxOutputTokens));
  }

  if (contextWindowMaxTokens === undefined || maxOutputTokens === undefined) {
    try {
      const lookup = await options.lookupModelsDev(row.id);
      if (lookup.found && lookup.candidates.length === 1) {
        const candidate = lookup.candidates[0];
        fillContextWindow(positiveCapacityValue(candidate.contextWindowMaxTokens));
        fillMaxOutput(positiveCapacityValue(candidate.maxOutputTokens));
      } else if (lookup.found && lookup.candidates.length > 1) {
        modelsDevCandidates = lookup.candidates;
      }
    } catch {
      // Keep configured/trusted values and mark unresolved context below.
    }
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

export function mergeCliproxyAdditionalModelLimits(
  existingModels: readonly CliproxyAdditionalModelLimits[],
  updates: readonly CliproxyAdditionalModelLimits[],
): CliproxyAdditionalModelLimits[] {
  const merged = existingModels.map((model) => ({ ...model }));
  const byId = new Map(merged.map((model) => [model.id, model]));

  for (const update of updates) {
    const existing = byId.get(update.id);
    if (!existing) {
      const added = { ...update };
      merged.push(added);
      byId.set(added.id, added);
      continue;
    }

    if (!existing.label && update.label) existing.label = update.label;
    if (
      positiveCapacityValue(existing.contextWindowMaxTokens) === undefined &&
      positiveCapacityValue(update.contextWindowMaxTokens) !== undefined
    ) {
      existing.contextWindowMaxTokens = update.contextWindowMaxTokens;
    }
    if (
      positiveCapacityValue(existing.maxOutputTokens) === undefined &&
      positiveCapacityValue(update.maxOutputTokens) !== undefined
    ) {
      existing.maxOutputTokens = update.maxOutputTokens;
    }
  }

  return merged;
}

function positiveCapacityValue(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
