import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

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

    let addedRows = 0;
    for (const value of page.data) {
      const row = mapCliproxyAnthropicModelRow(value);
      if (!row || seenIds.has(row.id)) continue;
      seenIds.add(row.id);
      rows.push(row);
      addedRows += 1;
    }

    if (!page.hasMore || !page.lastId || pages >= CLIPROXY_MODELS_MAX_PAGES || addedRows === 0) {
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

function parseCliproxyAnthropicModelsPage(payload: unknown): CliproxyAnthropicModelsPage {
  if (!isRecord(payload)) {
    return { data: [], hasMore: false, lastId: null };
  }

  const data = Array.isArray(payload.data) ? payload.data : [];
  const lastId = trimNonEmpty(payload.last_id);
  return { data, hasMore: payload.has_more === true, lastId };
}

function mapCliproxyAnthropicModelRow(value: unknown): CliproxyAnthropicModelRow | null {
  if (!isRecord(value)) return null;

  const rawListId = trimNonEmpty(value.id);
  if (!rawListId) return null;

  const id = decodeCliproxyClaudeModelId(rawListId);
  if (!id || isCliproxyNonChatModel({ id, displayName: readString(value.display_name) })) {
    return null;
  }

  const label = trimNonEmpty(value.display_name) ?? id;
  const ownedBy = readString(value.owned_by)?.trim() ?? "";
  const maxInputTokens = readFiniteNumber(value.max_input_tokens);
  const maxOutputTokens = readFiniteNumber(value.max_tokens);

  return {
    id,
    label,
    ownedBy,
    ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    rawListId,
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
