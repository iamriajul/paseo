// gateway/tps.ts — CLIProxyAPI generation throughput of the last request it
// served for a model (`GET /v1/last-request-tps?model=<id>`).
// The route only exists on newer Gateways; anything other than a well-formed
// 200 record (404 "never ran", 404 on a build without the route, bad key,
// transport failure) reports no sample so callers render nothing.
import { z } from "zod";

export const GATEWAY_TPS_TIMEOUT_MS = 10_000;

const GatewayTpsPayloadSchema = z.object({
  model: z.string(),
  alias: z.string().optional(),
  provider: z.string().optional(),
  at: z.string(),
  duration_ms: z.number(),
  ttft_ms: z.number(),
  generation_ms: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  tps: z.number(),
  stream: z.boolean(),
});

export interface GatewayTpsSample {
  model: string;
  alias?: string;
  provider?: string;
  at: string;
  durationMs: number;
  ttftMs: number;
  generationMs: number;
  inputTokens: number;
  outputTokens: number;
  tps: number;
  stream: boolean;
}

export interface GatewayTpsResult {
  supported: boolean;
  sample: GatewayTpsSample | null;
}

export interface FetchGatewayTpsOptions {
  baseUrl: string;
  token: string;
  /** Gateway slug for the model, or empty to read the newest request overall. */
  model: string;
  fetchImpl?: typeof fetch;
}

export async function fetchGatewayTps(options: FetchGatewayTpsOptions): Promise<GatewayTpsResult> {
  const empty: GatewayTpsResult = { supported: false, sample: null };
  const url = buildGatewayTpsUrl(options.baseUrl, options.model);
  if (!url) return empty;

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${options.token}` },
      signal: AbortSignal.timeout(GATEWAY_TPS_TIMEOUT_MS),
    });
  } catch {
    return empty;
  }

  if (response.status !== 200) return empty;

  const payload: unknown = await response.json().catch(() => undefined);
  const parsed = GatewayTpsPayloadSchema.safeParse(payload);
  if (!parsed.success) return empty;
  const sample = mapTpsSample(parsed.data);
  return sample ? { supported: true, sample } : empty;
}

function mapTpsSample(payload: z.infer<typeof GatewayTpsPayloadSchema>): GatewayTpsSample | null {
  // The record describes one completed request, so every counter is a real
  // measurement. A negative or non-finite one means the record is unusable,
  // not that the run was slow.
  if (!isMeasurement(payload.duration_ms) || !isMeasurement(payload.ttft_ms)) return null;
  if (!isMeasurement(payload.generation_ms)) return null;
  if (!isMeasurement(payload.input_tokens) || !isMeasurement(payload.output_tokens)) return null;
  if (!isMeasurement(payload.tps)) return null;
  const at = payload.at.trim();
  if (at.length === 0 || Number.isNaN(Date.parse(at))) return null;

  return {
    model: payload.model,
    ...(payload.alias ? { alias: payload.alias } : {}),
    ...(payload.provider ? { provider: payload.provider } : {}),
    at,
    durationMs: payload.duration_ms,
    ttftMs: payload.ttft_ms,
    generationMs: payload.generation_ms,
    inputTokens: payload.input_tokens,
    outputTokens: payload.output_tokens,
    tps: payload.tps,
    stream: payload.stream,
  };
}

function isMeasurement(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function buildGatewayTpsUrl(baseUrl: string, model?: string): string | null {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  if (!normalizedBaseUrl) return null;
  try {
    const url = new URL(`${normalizedBaseUrl}/v1/last-request-tps`);
    const slug = model?.trim();
    if (slug) url.searchParams.set("model", slug);
    return url.toString();
  } catch {
    return null;
  }
}
