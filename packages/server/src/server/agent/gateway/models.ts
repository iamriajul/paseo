// gateway/models.ts — CLIProxyAPI wire protocol shared by Gateway-routed providers.
// Decode mirrors CLIProxyAPI internal/util/claude_model.go; the Anthropic list
// rewrites every non-claude- id as `claude-fable-5-dd-` + reversed raw id.
export const CLAUDE_DD_MODEL_PREFIX = "claude-fable-5-dd-";

export const OFFICIAL_CPA_OWNERS: Record<string, true> = {
  anthropic: true,
  openai: true,
  codex: true,
  xai: true,
  "x-ai": true,
  grok: true,
  gemini: true,
  google: true,
  vertex: true,
  aistudio: true,
  antigravity: true,
  kimi: true,
  moonshot: true,
};

export const CLIPROXY_MODELS_MAX_PAGES = 20;
export const CLIPROXY_MODELS_TIMEOUT_MS = 8_000;
export const GATEWAY_CODEX_CLIENT_VERSION = "0.155.1";

export interface CliproxyAnthropicModelRow {
  id: string;
  label: string;
  ownedBy: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  rawListId: string;
}

export interface GatewayCodexModelRow {
  slug: string;
  displayName: string;
  description?: string;
  contextWindow?: number;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts: string[];
  hidden: boolean;
}

export interface FetchCliproxyAnthropicModelsOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  onWarning?: (warning: CliproxyAnthropicModelsWarning) => void;
  /**
   * Skip Gateway detection: the caller routes explicitly (first-party
   * `agents.gateway`) instead of auto-detecting a custom endpoint.
   */
  expectGateway?: boolean;
}

export interface FetchGatewayCodexModelsOptions {
  baseUrl: string;
  token: string;
  clientVersion?: string;
  fetchImpl?: typeof fetch;
  onWarning?: (warning: CliproxyAnthropicModelsWarning) => void;
  /**
   * Skip Gateway detection: the caller routes explicitly (first-party
   * `agents.gateway`) instead of auto-detecting a custom endpoint.
   */
  expectGateway?: boolean;
}

export type CliproxyAnthropicModelsWarningCode =
  | "invalid_url"
  | "request_failed"
  | "http_error"
  | "missing_fingerprint"
  | "invalid_json"
  | "invalid_payload"
  | "invalid_pagination"
  | "pagination_stalled"
  | "pagination_limit";

export interface CliproxyAnthropicModelsWarning {
  code: CliproxyAnthropicModelsWarningCode;
  page: number;
  status?: number;
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
  let pendingFingerprintCheck = false;

  while (pages < CLIPROXY_MODELS_MAX_PAGES) {
    const url = buildCliproxyModelsUrl(options.baseUrl, afterId);
    if (!url) {
      reportGatewayModelsWarning(options, { code: "invalid_url", page: pages + 1 });
      return rows;
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(CLIPROXY_MODELS_TIMEOUT_MS),
      });
    } catch {
      reportGatewayModelsWarning(options, { code: "request_failed", page: pages + 1 });
      return rows;
    }
    pages += 1;

    if (!response.ok) {
      reportGatewayModelsWarning(options, {
        code: "http_error",
        page: pages,
        status: response.status,
      });
      return rows;
    }
    // Tentative when headers are absent: some Gateways omit X-CPA-* on
    // /v1/models, so page one confirms the rewrite behaviorally instead.
    if (defersFingerprintToBehavior(options, response.headers, pages)) {
      pendingFingerprintCheck = true;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      reportGatewayModelsWarning(options, { code: "invalid_json", page: pages });
      return rows;
    }
    const page = parseCliproxyAnthropicModelsPage(payload);
    if (!page) {
      reportGatewayModelsWarning(options, { code: "invalid_payload", page: pages });
      return rows;
    }
    if (pendingFingerprintCheck && !pageHasRewrittenClaudeIds(page)) {
      reportGatewayModelsWarning(options, { code: "missing_fingerprint", page: pages });
      return [];
    }
    pendingFingerprintCheck = false;
    let addedDecodedIds = 0;
    for (const value of page.data) {
      const decodedModel = decodeCliproxyAnthropicModel(value);
      if (!decodedModel || seenIds.has(decodedModel.id)) continue;
      seenIds.add(decodedModel.id);
      addedDecodedIds += 1;

      const row = mapCliproxyAnthropicModelRow(value, decodedModel);
      if (row) rows.push(row);
    }

    if (!page.hasMore) {
      return rows;
    }
    if (!page.lastId) {
      reportGatewayModelsWarning(options, { code: "invalid_pagination", page: pages });
      return rows;
    }
    if (pages >= CLIPROXY_MODELS_MAX_PAGES) {
      reportGatewayModelsWarning(options, { code: "pagination_limit", page: pages });
      return rows;
    }
    if (addedDecodedIds === 0) {
      reportGatewayModelsWarning(options, { code: "pagination_stalled", page: pages });
      return rows;
    }
    afterId = page.lastId;
  }

  return rows;
}

/**
 * Fetch the Codex catalog shape (`?client_version=`): per-slug reasoning
 * levels plus context windows. Single response, no pagination.
 */
export async function fetchGatewayCodexModels(
  options: FetchGatewayCodexModelsOptions,
): Promise<GatewayCodexModelRow[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = buildGatewayCodexModelsUrl(
    options.baseUrl,
    options.clientVersion ?? GATEWAY_CODEX_CLIENT_VERSION,
  );
  if (!url) {
    reportGatewayModelsWarning(options, { code: "invalid_url", page: 1 });
    return [];
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${options.token}` },
      signal: AbortSignal.timeout(CLIPROXY_MODELS_TIMEOUT_MS),
    });
  } catch {
    reportGatewayModelsWarning(options, { code: "request_failed", page: 1 });
    return [];
  }

  if (!response.ok) {
    reportGatewayModelsWarning(options, {
      code: "http_error",
      page: 1,
      status: response.status,
    });
    return [];
  }
  const headerFingerprinted = responseHasCpaFingerprint(response.headers);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    reportGatewayModelsWarning(options, { code: "invalid_json", page: 1 });
    return [];
  }
  // Only CLIProxyAPI answers `?client_version` with a models envelope, which
  // proves the endpoint when `X-CPA-*` headers are absent (observed live).
  const hasCodexEnvelope = isRecord(payload) && Array.isArray(payload.models);
  if (!options.expectGateway && !headerFingerprinted && !hasCodexEnvelope) {
    reportGatewayModelsWarning(options, { code: "missing_fingerprint", page: 1 });
    return [];
  }
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    reportGatewayModelsWarning(options, { code: "invalid_payload", page: 1 });
    return [];
  }

  const rows: GatewayCodexModelRow[] = [];
  const seenSlugs = new Set<string>();
  for (const value of payload.models) {
    const row = mapGatewayCodexModelRow(value);
    if (!row || seenSlugs.has(row.slug)) continue;
    seenSlugs.add(row.slug);
    rows.push(row);
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

function parseCliproxyAnthropicModelsPage(payload: unknown): CliproxyAnthropicModelsPage | null {
  if (!isRecord(payload) || !Array.isArray(payload.data) || typeof payload.has_more !== "boolean") {
    return null;
  }

  const data = payload.data;
  const lastId = trimNonEmpty(payload.last_id);
  return { data, hasMore: payload.has_more === true, lastId };
}

/**
 * Behavioral Gateway proof: only CLIProxyAPI rewrites listing ids with the
 * `claude-fable-5-dd-` prefix. Used when the endpoint sends no `X-CPA-*`
 * headers (observed live) and the caller did not route explicitly.
 */
function pageHasRewrittenClaudeIds(page: CliproxyAnthropicModelsPage): boolean {
  return page.data.some(
    (value) =>
      isRecord(value) &&
      typeof value.id === "string" &&
      value.id.startsWith(CLAUDE_DD_MODEL_PREFIX),
  );
}

function defersFingerprintToBehavior(
  options: FetchCliproxyAnthropicModelsOptions,
  headers: Headers,
  pages: number,
): boolean {
  return pages === 1 && !options.expectGateway && !responseHasCpaFingerprint(headers);
}

function reportGatewayModelsWarning(
  options: Pick<FetchCliproxyAnthropicModelsOptions, "onWarning">,
  warning: CliproxyAnthropicModelsWarning,
): void {
  try {
    options.onWarning?.(warning);
  } catch {
    // A diagnostic warning hook must never change catalog discovery behavior.
  }
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

function mapGatewayCodexModelRow(value: unknown): GatewayCodexModelRow | null {
  if (!isRecord(value)) return null;
  const slug = trimNonEmpty(value.slug);
  if (!slug) return null;
  if (isCliproxyNonChatModel({ id: slug, displayName: readString(value.display_name) })) {
    return null;
  }

  const supportedReasoningEfforts: string[] = [];
  if (Array.isArray(value.supported_reasoning_levels)) {
    for (const level of value.supported_reasoning_levels) {
      const effort = isRecord(level) ? trimNonEmpty(level.effort) : null;
      if (effort) supportedReasoningEfforts.push(effort);
    }
  }
  let visibility: string[];
  if (Array.isArray(value.visibility)) {
    visibility = value.visibility.filter((entry): entry is string => typeof entry === "string");
  } else if (typeof value.visibility === "string") {
    visibility = [value.visibility];
  } else {
    visibility = [];
  }
  const description = trimNonEmpty(value.description);
  const contextWindow = readFiniteNumber(value.context_window);
  const defaultReasoningEffort = trimNonEmpty(value.default_reasoning_level);

  return {
    slug,
    displayName: trimNonEmpty(value.display_name) ?? slug,
    ...(description === null ? {} : { description }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(defaultReasoningEffort === null ? {} : { defaultReasoningEffort }),
    supportedReasoningEfforts,
    hidden: visibility.includes("hide"),
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

function buildGatewayCodexModelsUrl(baseUrl: string, clientVersion: string): string | null {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  if (!normalizedBaseUrl) return null;

  try {
    const url = new URL(`${normalizedBaseUrl}/v1/models`);
    url.searchParams.set("client_version", clientVersion);
    return url.toString();
  } catch {
    return null;
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
  return OFFICIAL_CPA_OWNERS[ownedBy.trim().toLowerCase()] === true;
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
