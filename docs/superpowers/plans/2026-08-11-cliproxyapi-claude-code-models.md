# CLIProxyAPI Claude Code Model Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Claude Code is routed through CLIProxyAPI, discover gateway models via Anthropic-format `/v1/models`, decode rewritten ids to raw slugs, append them to the Claude catalog with correct capacity, and softly prompt when metadata still needs configuration.

**Architecture:** Add pure CPA helpers under the Claude provider (`cliproxy-models.ts`). Hook them into `ClaudeAgentClient.fetchCatalog` after the existing manifest + settings catalog. Resolve capacity with an official `owned_by` allowlist (trust CPA limits) vs models.dev / soft warning for OpenAI-compat brands. Auto-persist resolved limits into `agents.providers.claude.additionalModels` so launch env pins work. UI shows a round warning control with the locked tooltip copy on models that still need capacity config.

**Tech Stack:** TypeScript, Vitest, existing `lookupModelsDevModel`, daemon config store `additionalModels`, React Native Unistyles + `@/components/ui/tooltip`, protocol `AgentModelDefinition`.

**Spec:** `docs/superpowers/specs/2026-08-11-cliproxyapi-claude-code-models-design.md`

## Global Constraints

- Discover only when both `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` resolve and the response has an `X-CPA-*` header; otherwise no-op.
- Use **Anthropic-format** `GET /v1/models` only (not Codex `?client_version`).
- **Decode** `claude-fable-5-dd-*` to raw ids before catalog/storage/launch; never show rewritten ids as the model id.
- Catalog merge: **append only** missing decoded ids; never replace built-in Claude models.
- Capacity trust: official `owned_by` allowlist only; never trust OpenAI-compat template limits (e.g. `OpenCodeGo`).
- Effort picker: Claude custom/manifest defaults only — **do not** import Codex reasoning levels.
- Incomplete capacity: soft warning, always selectable; copy exactly **“Configure metadata for the best experience.”**
- Defensive pagination: loop `after_id` while `has_more`; CPA today always returns full list with `has_more: false`.
- Never log raw auth tokens.
- Follow repo rules: targeted vitest only (`npx vitest run <file> --bail=1`), then `npm run typecheck`, `npm run lint`, `npm run format` after changes; no full suite; no daemon restart on 6767.

## File Structure

| File                                                                                 | Responsibility                                                                                                                                    |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/server/agent/providers/claude/cliproxy-models.ts`               | Credential resolve, decode, fetch+paginate, map, trust, capacity enrich, merge append, auto-persist candidates                                    |
| `packages/server/src/server/agent/providers/claude/cliproxy-models.test.ts`          | Unit tests for all pure helpers with mock `fetch`                                                                                                 |
| `packages/server/src/server/agent/providers/claude/models.ts`                        | Optionally re-export nothing; keep existing limit/env helpers; may extend `resolveClaudeContextWindowMaxTokens` only if needed after auto-persist |
| `packages/server/src/server/agent/providers/claude/agent.ts`                         | Wire CPA discovery into `fetchCatalog`; optional persist callback on client options                                                               |
| `packages/server/src/server/agent/providers/claude/models.test.ts` / `agent.test.ts` | Catalog integration tests (mock fetch / inject discovery)                                                                                         |
| `packages/server/src/server/agent/provider-registry.ts`                              | Pass persist callback / config access into Claude client when building registry if required                                                       |
| `packages/protocol/src/agent-types.ts`                                               | Optional `needsCapacityConfig`, `modelsDevCandidates`, ensure `maxOutputTokens` stays on type                                                     |
| `packages/protocol/src/messages.ts`                                                  | Optional fields on `AgentModelDefinitionSchema` (incl. `maxOutputTokens` if missing) + regenerate validators                                      |
| `packages/app/src/components/provider-diagnostic-sheet.tsx`                          | Warning icon on discovered rows with needsCapacityConfig                                                                                          |
| `packages/app/src/i18n/resources/en.ts` (+ other locales as needed)                  | Tooltip / a11y strings                                                                                                                            |
| `docs/custom-providers.md`                                                           | Short section linking CPA Claude discovery behavior                                                                                               |

### Locked constants (implementers)

```ts
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
```

### Capacity rule (locked)

For each CPA-discovered model after decode:

1. If profile/`additionalModels` already has positive limits for that id → those win; no warning.
2. Else if `owned_by` (lowercased) ∈ `OFFICIAL_CPA_OWNERS` and `max_input_tokens` > 0 → trust CPA input/output; set on model; schedule auto-persist.
3. Else → models.dev lookup on decoded id:
   - 1 hit → apply limits + auto-persist; clear warning
   - N hits → `needsCapacityConfig: true` + `modelsDevCandidates`
   - 0/error → `needsCapacityConfig: true` only

### Auto-persist (locked)

Resolved limits (trusted CPA or single models.dev hit) must be merged into `agents.providers.claude.additionalModels` by id:

- Preserve existing label / user fields when present.
- Fill missing `contextWindowMaxTokens` / `maxOutputTokens` only (do not overwrite user-set positive values).
- Persist so `ClaudeAgentSession.buildSdkEnv` → `resolveClaudeContextWindowMaxTokens` / `resolveClaudeMaxOutputTokens` via `profileModels` keeps working without a separate CPA cache.

---

### Task 1: Decode + official-owner helpers (pure)

**Files:**

- Create: `packages/server/src/server/agent/providers/claude/cliproxy-models.ts`
- Create: `packages/server/src/server/agent/providers/claude/cliproxy-models.test.ts`

**Interfaces:**

- Produces:
  - `decodeCliproxyClaudeModelId(id: string): string`
  - `isOfficialCpaOwner(ownedBy: string | null | undefined): boolean`
  - `isCliproxyNonChatModel(options: { id: string; displayName?: string }): boolean`

- [ ] **Step 1: Write failing tests for decode and owner trust**

```ts
import { describe, expect, test } from "vitest";
import {
  decodeCliproxyClaudeModelId,
  isOfficialCpaOwner,
  isCliproxyNonChatModel,
} from "./cliproxy-models.js";

describe("decodeCliproxyClaudeModelId", () => {
  test("decodes reversed non-claude ids", () => {
    expect(decodeCliproxyClaudeModelId("claude-fable-5-dd-5.4-korg")).toBe("grok-4.5");
    expect(decodeCliproxyClaudeModelId("claude-fable-5-dd-los-6.5-tpg")).toBe("gpt-5.6-sol");
    expect(decodeCliproxyClaudeModelId("claude-fable-5-dd-xam-8.3newq")).toBe("qwen3.8-max");
  });

  test("leaves real claude ids unchanged", () => {
    expect(decodeCliproxyClaudeModelId("claude-fable-5")).toBe("claude-fable-5");
    expect(decodeCliproxyClaudeModelId("claude-opus-5")).toBe("claude-opus-5");
  });

  test("preserves thinking suffix on encoded ids", () => {
    expect(decodeCliproxyClaudeModelId("claude-fable-5-dd-5.4-korg(high)")).toBe("grok-4.5(high)");
  });
});

describe("isOfficialCpaOwner", () => {
  test("accepts official brands case-insensitively", () => {
    expect(isOfficialCpaOwner("openai")).toBe(true);
    expect(isOfficialCpaOwner("Anthropic")).toBe(true);
    expect(isOfficialCpaOwner("xAI")).toBe(true);
    expect(isOfficialCpaOwner("antigravity")).toBe(true);
  });

  test("rejects openai-compat and empty", () => {
    expect(isOfficialCpaOwner("OpenCodeGo")).toBe(false);
    expect(isOfficialCpaOwner("")).toBe(false);
    expect(isOfficialCpaOwner(undefined)).toBe(false);
  });
});

describe("isCliproxyNonChatModel", () => {
  test("filters image and video models by decoded id", () => {
    expect(isCliproxyNonChatModel({ id: "gpt-image-2" })).toBe(true);
    expect(isCliproxyNonChatModel({ id: "grok-imagine-video" })).toBe(true);
    expect(isCliproxyNonChatModel({ id: "grok-4.5", displayName: "Grok 4.5" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && npx vitest run src/server/agent/providers/claude/cliproxy-models.test.ts --bail=1`

Expected: FAIL (module missing)

- [ ] **Step 3: Implement helpers**

```ts
// cliproxy-models.ts — decode mirrors CLIProxyAPI internal/util/claude_model.go
export const CLAUDE_DD_MODEL_PREFIX = "claude-fable-5-dd-";

export function decodeCliproxyClaudeModelId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return trimmed;

  const match = /^(.*)\(([^()]*)\)$/.exec(trimmed);
  const base = match?.[1] ?? trimmed;
  const suffix = match ? `(${match[2]})` : "";

  if (!base.startsWith(CLAUDE_DD_MODEL_PREFIX)) return trimmed;
  const encoded = base.slice(CLAUDE_DD_MODEL_PREFIX.length);
  if (!encoded) return trimmed;
  return [...encoded].reverse().join("") + suffix;
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && npx vitest run src/server/agent/providers/claude/cliproxy-models.test.ts --bail=1`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server/agent/providers/claude/cliproxy-models.ts \
  packages/server/src/server/agent/providers/claude/cliproxy-models.test.ts
git commit -m "feat(claude): add CLIProxyAPI model id decode and owner trust helpers"
```

---

### Task 2: Credential resolve + Anthropic list fetch with defensive pagination

**Files:**

- Modify: `packages/server/src/server/agent/providers/claude/cliproxy-models.ts`
- Modify: `packages/server/src/server/agent/providers/claude/cliproxy-models.test.ts`

**Interfaces:**

- Consumes: Task 1 helpers
- Produces:
  - `resolveCliproxyAnthropicCredentials(options): { baseUrl: string; token: string } | null`
  - `fetchCliproxyAnthropicModels(options): Promise<CliproxyAnthropicModelRow[]>`
  - `responseHasCpaFingerprint(headers: Headers): boolean`

```ts
export interface CliproxyAnthropicModelRow {
  id: string; // already decoded
  label: string;
  ownedBy: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  rawListId: string;
}
```

- [ ] **Step 1: Write failing tests for credentials, fingerprint, pagination**

```ts
describe("resolveCliproxyAnthropicCredentials", () => {
  test("prefers process env over settings.json", async () => {
    const resolved = await resolveCliproxyAnthropicCredentials({
      env: {
        ANTHROPIC_BASE_URL: "http://env.example",
        ANTHROPIC_AUTH_TOKEN: "env-token",
      },
      readSettingsEnv: async () => ({
        ANTHROPIC_BASE_URL: "http://settings.example",
        ANTHROPIC_AUTH_TOKEN: "settings-token",
      }),
    });
    expect(resolved).toEqual({
      baseUrl: "http://env.example",
      token: "env-token",
    });
  });

  test("falls back to settings.json env", async () => {
    const resolved = await resolveCliproxyAnthropicCredentials({
      env: {},
      readSettingsEnv: async () => ({
        ANTHROPIC_BASE_URL: "http://settings.example/",
        ANTHROPIC_AUTH_TOKEN: " settings-token ",
      }),
    });
    expect(resolved).toEqual({
      baseUrl: "http://settings.example",
      token: "settings-token",
    });
  });

  test("returns null when either key missing", async () => {
    expect(
      await resolveCliproxyAnthropicCredentials({
        env: { ANTHROPIC_BASE_URL: "http://x" },
        readSettingsEnv: async () => ({}),
      }),
    ).toBeNull();
  });
});

describe("fetchCliproxyAnthropicModels", () => {
  test("returns empty when response lacks X-CPA fingerprint", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [], has_more: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const rows = await fetchCliproxyAnthropicModels({
      baseUrl: "http://cpa.example",
      token: "t",
      fetchImpl,
    });
    expect(rows).toEqual([]);
  });

  test("loads single page when has_more is false", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "claude-fable-5-dd-5.4-korg",
                display_name: "Grok 4.5",
                owned_by: "xai",
                max_input_tokens: 500000,
                max_tokens: 65536,
              },
            ],
            has_more: false,
            first_id: "claude-fable-5-dd-5.4-korg",
            last_id: "claude-fable-5-dd-5.4-korg",
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-cpa-version": "1",
            },
          },
        ),
    );
    const rows = await fetchCliproxyAnthropicModels({
      baseUrl: "http://cpa.example",
      token: "t",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([
      {
        id: "grok-4.5",
        label: "Grok 4.5",
        ownedBy: "xai",
        maxInputTokens: 500000,
        maxOutputTokens: 65536,
        rawListId: "claude-fable-5-dd-5.4-korg",
      },
    ]);
  });

  test("follows after_id while has_more is true and dedupes", async () => {
    const pages = [
      {
        data: [
          {
            id: "claude-a",
            display_name: "A",
            owned_by: "anthropic",
            max_input_tokens: 200000,
            max_tokens: 64000,
          },
        ],
        has_more: true,
        last_id: "claude-a",
      },
      {
        data: [
          {
            id: "claude-a",
            display_name: "A",
            owned_by: "anthropic",
            max_input_tokens: 200000,
            max_tokens: 64000,
          },
          {
            id: "claude-b",
            display_name: "B",
            owned_by: "anthropic",
            max_input_tokens: 200000,
            max_tokens: 64000,
          },
        ],
        has_more: false,
        last_id: "claude-b",
      },
    ];
    let call = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      const body = pages[call++]!;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", "x-cpa-version": "1" },
      });
    });
    const rows = await fetchCliproxyAnthropicModels({
      baseUrl: "http://cpa.example",
      token: "t",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("after_id=claude-a");
    expect(rows.map((r) => r.id)).toEqual(["claude-a", "claude-b"]);
  });

  test("stops when a page adds no new decoded ids", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "claude-a",
                display_name: "A",
                owned_by: "anthropic",
                max_input_tokens: 1,
                max_tokens: 1,
              },
            ],
            has_more: true,
            last_id: "claude-a",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", "x-cpa-version": "1" },
          },
        ),
    );
    const rows = await fetchCliproxyAnthropicModels({
      baseUrl: "http://cpa.example",
      token: "t",
      fetchImpl,
    });
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(CLIPROXY_MODELS_MAX_PAGES);
    expect(rows.map((r) => r.id)).toEqual(["claude-a"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && npx vitest run src/server/agent/providers/claude/cliproxy-models.test.ts --bail=1`

Expected: FAIL on missing exports

- [ ] **Step 3: Implement credential resolve + fetch**

Implementation notes:

- Strip trailing `/` from baseUrl.
- Request headers: `Authorization: Bearer ${token}`, `Anthropic-Version: 2023-06-01`, `User-Agent: claude-cli/paseo`.
- Fingerprint: any response header name matching `/^x-cpa-/i` (check first successful page; if first page has no fingerprint, return `[]`).
- Parse `data` array; skip non-objects; decode id; skip non-chat; skip empty ids.
- Pagination: while `has_more === true` && `last_id` && pages < `CLIPROXY_MODELS_MAX_PAGES`; if page adds zero new decoded ids, break; if follow-up fails, return what was collected.
- Timeout via `AbortSignal.timeout(CLIPROXY_MODELS_TIMEOUT_MS)` or equivalent.
- settings.json reader: read `configDir/settings.json` (default `CLAUDE_CONFIG_DIR` or `~/.claude`), parse `env` object for the two keys; on failure return `{}`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && npx vitest run src/server/agent/providers/claude/cliproxy-models.test.ts --bail=1`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server/agent/providers/claude/cliproxy-models.ts \
  packages/server/src/server/agent/providers/claude/cliproxy-models.test.ts
git commit -m "feat(claude): fetch CLIProxyAPI Anthropic model list with defensive pagination"
```

---

### Task 3: Map rows → AgentModelDefinition, merge append, capacity enrich

**Files:**

- Modify: `packages/server/src/server/agent/providers/claude/cliproxy-models.ts`
- Modify: `packages/server/src/server/agent/providers/claude/cliproxy-models.test.ts`

**Interfaces:**

- Consumes: Task 1–2, `lookupModelsDevModel` from `packages/server/src/server/models-dev/catalog.ts`
- Produces:
  - `appendCliproxyModelsToClaudeCatalog(options): Promise<AppendCliproxyModelsResult>`

```ts
export interface AppendCliproxyModelsResult {
  models: AgentModelDefinition[];
  /** Limits to merge into additionalModels (trusted CPA or single models.dev hit). */
  autoPersist: Array<{
    id: string;
    label?: string;
    contextWindowMaxTokens?: number;
    maxOutputTokens?: number;
  }>;
}
```

- [ ] **Step 1: Write failing capacity/merge tests**

```ts
describe("appendCliproxyModelsToClaudeCatalog", () => {
  const base = [
    {
      provider: "claude" as const,
      id: "claude-fable-5",
      label: "Claude Fable 5",
      contextWindowMaxTokens: 1_000_000,
    },
  ];

  test("appends only missing decoded ids", async () => {
    const result = await appendCliproxyModelsToClaudeCatalog({
      baseModels: base,
      rows: [
        {
          id: "claude-fable-5",
          label: "Claude Fable 5",
          ownedBy: "anthropic",
          maxInputTokens: 1_000_000,
          maxOutputTokens: 128_000,
          rawListId: "claude-fable-5",
        },
        {
          id: "grok-4.5",
          label: "Grok 4.5",
          ownedBy: "xai",
          maxInputTokens: 500_000,
          maxOutputTokens: 65_536,
          rawListId: "claude-fable-5-dd-5.4-korg",
        },
      ],
      existingAdditionalModels: [],
      lookupModelsDev: async () => ({ found: false, query: "unused" }),
      getCustomThinkingOptions: () => [{ id: "max", label: "Max" }],
    });
    expect(result.models.map((m) => m.id)).toEqual(["claude-fable-5", "grok-4.5"]);
    const grok = result.models.find((m) => m.id === "grok-4.5")!;
    expect(grok.contextWindowMaxTokens).toBe(500_000);
    expect(grok.maxOutputTokens).toBe(65_536);
    expect(grok.needsCapacityConfig).toBeUndefined();
    expect(result.autoPersist).toEqual([
      {
        id: "grok-4.5",
        label: "Grok 4.5",
        contextWindowMaxTokens: 500_000,
        maxOutputTokens: 65_536,
      },
    ]);
  });

  test("does not trust OpenCodeGo CPA limits; uses models.dev single hit", async () => {
    const result = await appendCliproxyModelsToClaudeCatalog({
      baseModels: base,
      rows: [
        {
          id: "qwen3.8-max",
          label: "qwen3.8-max",
          ownedBy: "OpenCodeGo",
          maxInputTokens: 200_000,
          maxOutputTokens: 64_000,
          rawListId: "claude-fable-5-dd-xam-8.3newq",
        },
      ],
      existingAdditionalModels: [],
      lookupModelsDev: async () => ({
        found: true,
        query: "qwen3.8-max",
        matchedId: "qwen3.8-max",
        providerId: "opencode-go",
        contextWindowMaxTokens: 1_000_000,
        maxOutputTokens: 131_072,
        candidates: [
          {
            providerId: "opencode-go",
            matchedId: "qwen3.8-max",
            contextWindowMaxTokens: 1_000_000,
            maxOutputTokens: 131_072,
          },
        ],
      }),
      getCustomThinkingOptions: () => [{ id: "max", label: "Max" }],
    });
    const qwen = result.models.find((m) => m.id === "qwen3.8-max")!;
    expect(qwen.contextWindowMaxTokens).toBe(1_000_000);
    expect(qwen.maxOutputTokens).toBe(131_072);
    expect(qwen.needsCapacityConfig).toBeUndefined();
    expect(result.autoPersist[0]?.contextWindowMaxTokens).toBe(1_000_000);
  });

  test("marks multi models.dev hits as needsCapacityConfig", async () => {
    const result = await appendCliproxyModelsToClaudeCatalog({
      baseModels: base,
      rows: [
        {
          id: "qwen3.8-max",
          label: "qwen3.8-max",
          ownedBy: "OpenCodeGo",
          maxInputTokens: 200_000,
          maxOutputTokens: 64_000,
          rawListId: "x",
        },
      ],
      existingAdditionalModels: [],
      lookupModelsDev: async () => ({
        found: true,
        query: "qwen3.8-max",
        matchedId: "qwen3.8-max",
        providerId: "opencode-go",
        contextWindowMaxTokens: 1_000_000,
        candidates: [
          {
            providerId: "opencode-go",
            matchedId: "qwen3.8-max",
            contextWindowMaxTokens: 1_000_000,
          },
          {
            providerId: "openrouter",
            matchedId: "qwen/qwen3.8-max",
            contextWindowMaxTokens: 1_000_000,
          },
        ],
      }),
      getCustomThinkingOptions: () => [{ id: "max", label: "Max" }],
    });
    const qwen = result.models.find((m) => m.id === "qwen3.8-max")!;
    expect(qwen.needsCapacityConfig).toBe(true);
    expect(qwen.modelsDevCandidates).toHaveLength(2);
    expect(qwen.contextWindowMaxTokens).toBeUndefined();
    expect(result.autoPersist).toEqual([]);
  });

  test("existing additionalModels limits win and clear warning", async () => {
    const result = await appendCliproxyModelsToClaudeCatalog({
      baseModels: base,
      rows: [
        {
          id: "qwen3.8-max",
          label: "qwen3.8-max",
          ownedBy: "OpenCodeGo",
          maxInputTokens: 200_000,
          maxOutputTokens: 64_000,
          rawListId: "x",
        },
      ],
      existingAdditionalModels: [
        { id: "qwen3.8-max", contextWindowMaxTokens: 999_999, maxOutputTokens: 12_345 },
      ],
      lookupModelsDev: async () => {
        throw new Error("should not be called");
      },
      getCustomThinkingOptions: () => [{ id: "max", label: "Max" }],
    });
    const qwen = result.models.find((m) => m.id === "qwen3.8-max")!;
    expect(qwen.contextWindowMaxTokens).toBe(999_999);
    expect(qwen.maxOutputTokens).toBe(12_345);
    expect(qwen.needsCapacityConfig).toBeUndefined();
    expect(result.autoPersist).toEqual([]);
  });

  test("does not overwrite openai subscription windows via models.dev", async () => {
    const lookup = vi.fn(async () => ({
      found: true,
      query: "gpt-5.6-sol",
      matchedId: "gpt-5.6-sol",
      providerId: "openai",
      contextWindowMaxTokens: 1_000_000,
      candidates: [],
    }));
    const result = await appendCliproxyModelsToClaudeCatalog({
      baseModels: base,
      rows: [
        {
          id: "gpt-5.6-sol",
          label: "GPT 5.6 Sol",
          ownedBy: "openai",
          maxInputTokens: 372_000,
          maxOutputTokens: 128_000,
          rawListId: "claude-fable-5-dd-los-6.5-tpg",
        },
      ],
      existingAdditionalModels: [],
      lookupModelsDev: lookup,
      getCustomThinkingOptions: () => [{ id: "max", label: "Max" }],
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(result.models.find((m) => m.id === "gpt-5.6-sol")?.contextWindowMaxTokens).toBe(372_000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && npx vitest run src/server/agent/providers/claude/cliproxy-models.test.ts --bail=1`

Expected: FAIL on missing `appendCliproxyModelsToClaudeCatalog`

- [ ] **Step 3: Implement map/merge/capacity**

For each new row not already in `baseModels` by id:

```ts
{
  provider: "claude",
  id: row.id,
  label: row.label || row.id,
  description: row.label && row.label !== row.id ? row.label : undefined,
  thinkingOptions: getCustomThinkingOptions(),
  metadata: {
    source: "cliproxyapi",
    ownedBy: row.ownedBy,
  },
  // capacity fields set per rule
}
```

Use `getClaudeCustomModelThinkingOptions()` from `model-manifest.ts` at the call site (inject in tests).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && npx vitest run src/server/agent/providers/claude/cliproxy-models.test.ts --bail=1`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server/agent/providers/claude/cliproxy-models.ts \
  packages/server/src/server/agent/providers/claude/cliproxy-models.test.ts
git commit -m "feat(claude): map CLIProxyAPI models into Claude catalog with capacity rules"
```

---

### Task 4: Protocol optional fields (`needsCapacityConfig`, `modelsDevCandidates`, `maxOutputTokens`)

**Files:**

- Modify: `packages/protocol/src/agent-types.ts`
- Modify: `packages/protocol/src/messages.ts` (`AgentModelDefinitionSchema`)
- Modify: `packages/server/src/server/agent/agent-sdk-types.ts` only if it re-exports a local duplicate (prefer protocol type)
- Run protocol validator generation via package pretypecheck

**Interfaces:**

- Produces optional fields on `AgentModelDefinition`:

```ts
needsCapacityConfig?: boolean;
modelsDevCandidates?: Array<{
  providerId: string;
  matchedId: string;
  name?: string;
  contextWindowMaxTokens: number;
  maxOutputTokens?: number;
}>;
maxOutputTokens?: number; // ensure present on type + zod schema
```

- [ ] **Step 1: Add fields to type + zod schema**

In `agent-types.ts` `AgentModelDefinition`, ensure:

```ts
contextWindowMaxTokens?: number;
maxOutputTokens?: number;
needsCapacityConfig?: boolean;
modelsDevCandidates?: Array<{
  providerId: string;
  matchedId: string;
  name?: string;
  contextWindowMaxTokens: number;
  maxOutputTokens?: number;
}>;
```

In `messages.ts` `AgentModelDefinitionSchema`, add optional zod fields matching the type (all optional for backward compat). Include `maxOutputTokens` if missing today.

- [ ] **Step 2: Rebuild protocol validators / typecheck protocol**

Run:

```bash
npm run typecheck --workspace=@getpaseo/protocol
# or from packages/protocol: npm run typecheck
```

Expected: PASS (pretypecheck regenerates AOT validators)

- [ ] **Step 3: Commit**

```bash
git add packages/protocol/src/agent-types.ts packages/protocol/src/messages.ts \
  packages/protocol/src/generated/validation/ws-outbound.aot.ts
git commit -m "feat(protocol): optional Claude CPA capacity config fields on models"
```

---

### Task 5: Wire discovery into Claude `fetchCatalog` + auto-persist additionalModels

**Files:**

- Modify: `packages/server/src/server/agent/providers/claude/agent.ts`
- Modify: `packages/server/src/server/agent/provider-registry.ts` (pass persist hook / existing additional models)
- Modify: `packages/server/src/server/agent/providers/claude/models.test.ts` and/or new `cliproxy-models` integration tests via client
- Possibly: bootstrap only if registry needs `DaemonConfigStore` — prefer injecting a small callback

**Interfaces:**

- Consumes: `appendCliproxyModelsToClaudeCatalog`, `fetchCliproxyAnthropicModels`, `resolveCliproxyAnthropicCredentials`
- Produces: Claude catalog includes CPA models; config may gain additionalModels entries

- [ ] **Step 1: Extend `ClaudeAgentClientOptions`**

```ts
export interface ClaudeAgentClientOptions {
  // existing fields...
  /** Existing claude additionalModels from daemon config (for capacity precedence). */
  additionalModels?: Array<{
    id: string;
    label?: string;
    contextWindowMaxTokens?: number;
    maxOutputTokens?: number;
  }>;
  /**
   * Persist auto-resolved capacity into agents.providers.claude.additionalModels.
   * Must merge by id and not overwrite user-set positive limits.
   */
  persistClaudeAdditionalModelLimits?: (
    models: Array<{
      id: string;
      label?: string;
      contextWindowMaxTokens?: number;
      maxOutputTokens?: number;
    }>,
  ) => void | Promise<void>;
}
```

- [ ] **Step 2: Update `fetchCatalog`**

After `getClaudeModelsWithSettings(...)`:

```ts
const credentials = await resolveCliproxyAnthropicCredentials({
  env: createProviderEnv({ baseEnv: process.env, runtimeSettings: this.runtimeSettings }),
  configDir: this.configDir,
});
if (credentials) {
  try {
    const rows = await fetchCliproxyAnthropicModels(credentials);
    if (rows.length > 0) {
      const { models: nextModels, autoPersist } = await appendCliproxyModelsToClaudeCatalog({
        baseModels: models,
        rows,
        existingAdditionalModels: this.additionalModels ?? this.profileModels ?? [],
        lookupModelsDev: (id) => lookupModelsDevModel(id),
        getCustomThinkingOptions: () => getClaudeCustomModelThinkingOptions(),
      });
      models = nextModels;
      if (autoPersist.length > 0 && this.persistClaudeAdditionalModelLimits) {
        await this.persistClaudeAdditionalModelLimits(autoPersist);
      }
    }
  } catch (error) {
    this.logger.warn({ err: error }, "CLIProxyAPI Claude model discovery failed");
  }
}
```

Then continue returning modes as today.

- [ ] **Step 3: Wire persist from registry**

In `provider-registry.ts` where `new ClaudeAgentClient({...})` is constructed (~line 188):

- Pass `additionalModels` / `profileModels` already available for Claude.
- Pass `persistClaudeAdditionalModelLimits` only if a store callback is available.

If `BuildProviderRegistryOptions` does not have config store today, add an optional:

```ts
persistClaudeAdditionalModelLimits?: ClaudeAgentClientOptions["persistClaudeAdditionalModelLimits"];
```

Wire from bootstrap where `buildProviderRegistry` is called and `daemonConfigStore` exists:

```ts
persistClaudeAdditionalModelLimits: async (models) => {
  const current = daemonConfigStore.get();
  const existing = current.providers?.claude?.additionalModels ?? [];
  const merged = mergeAdditionalModelLimits(existing, models);
  if (merged !== existing) {
    daemonConfigStore.patch({
      providers: {
        claude: {
          additionalModels: merged,
        },
      },
    });
  }
},
```

Implement `mergeAdditionalModelLimits` in `cliproxy-models.ts` (pure, unit-tested): by id, fill missing positive context/output only; preserve labels.

- [ ] **Step 4: Unit test mergeAdditionalModelLimits + a fetchCatalog test with mocked fetch**

Prefer testing pure merge + testing `fetchCatalog` by injecting fetch/credentials via dependency injection on the helper path (keep agent test thin).

- [ ] **Step 5: Run targeted tests**

```bash
cd packages/server && npx vitest run \
  src/server/agent/providers/claude/cliproxy-models.test.ts \
  src/server/agent/providers/claude/models.test.ts \
  --bail=1
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/server/agent/providers/claude \
  packages/server/src/server/agent/provider-registry.ts \
  packages/server/src/server/bootstrap.ts
git commit -m "feat(claude): discover CLIProxyAPI models in fetchCatalog and auto-persist limits"
```

---

### Task 6: Launch env already works via additionalModels — verify + fill gaps

**Files:**

- Modify: `packages/server/src/server/agent/providers/claude/models.ts` only if `resolveClaudeContextWindowMaxTokens` must also read catalog model limits without persist (prefer auto-persist from Task 5)
- Modify: `packages/server/src/server/agent/providers/claude/agent.env.test.ts` or `models.test.ts`

**Interfaces:**

- Consumes: existing `buildSdkEnv` → `resolveClaudeContextWindowMaxTokens` / `resolveClaudeMaxOutputTokens` with `profileModels`

- [ ] **Step 1: Write/extend env test**

```ts
test("applies context and output env from profileModels for CPA-discovered custom model", async () => {
  // arrange ClaudeAgentSession / client with profileModels:
  // [{ id: "grok-4.5", contextWindowMaxTokens: 500_000, maxOutputTokens: 65_536 }]
  // config.model = "grok-4.5"
  // assert buildSdkEnv / options.env has:
  // CLAUDE_CODE_MAX_CONTEXT_TOKENS=500000
  // CLAUDE_CODE_MAX_OUTPUT_TOKENS=65536
  // and does not overwrite pre-set env
});
```

Use the same patterns as existing `agent.env.test.ts` for glm-5.1.

- [ ] **Step 2: Run test (fail if gap), implement only if needed, re-run**

Run: `cd packages/server && npx vitest run src/server/agent/providers/claude/agent.env.test.ts --bail=1`

Expected: PASS (auto-persist + existing resolvers should be enough)

- [ ] **Step 3: Commit if any code changed**

```bash
git add packages/server/src/server/agent/providers/claude
git commit -m "test(claude): cover CPA capacity env pins via profileModels"
```

---

### Task 7: UI — soft warning control on models needing capacity config

**Files:**

- Modify: `packages/app/src/components/provider-diagnostic-sheet.tsx` (`DiscoveredModelRow`)
- Modify: `packages/app/src/i18n/resources/en.ts` (and mirror keys in other locale files if CI requires)
- Optionally: model picker row if a separate component shows Claude models outside the diagnostic sheet — search for other model list UIs and apply the same control if the catalog field is present

**Interfaces:**

- Consumes: `model.needsCapacityConfig`, `model.modelsDevCandidates`
- Uses: `@/components/ui/tooltip` with **`enabledOnDesktop` and `enabledOnMobile={true}`** (or both true) so round control is touchable on every platform; hover works on web/desktop via existing Tooltip behavior

- [ ] **Step 1: Add i18n strings (en first)**

```ts
// settings.providers.models.capacityWarning
// tooltip / a11y:
"Configure metadata for the best experience.";
// optional configure action label:
"Configure";
```

- [ ] **Step 2: Update `DiscoveredModelRow`**

When `model.needsCapacityConfig === true`:

- Render a round hit target (warning icon, e.g. Lucide `AlertTriangle` or existing warning glyph used in app).
- Wrap with `Tooltip` / `TooltipTrigger` / `TooltipContent`:
  - Copy: **Configure metadata for the best experience.**
  - `enabledOnDesktop`
  - `enabledOnMobile` **true** (spec: touchable on every platform; hover desktop/web only is fine as extra)
- Pressing the control shows the message (tooltip). Prefer explicit secondary “Configure” that opens existing custom model form / models.dev chooser with the model id prefilled and candidates when present — reuse `CustomModelFormSubSheet` / form helpers if straightforward; otherwise open Add/Edit model sheet with id prefilled as minimum.

Model row remains non-blocking; do not disable selection elsewhere.

- [ ] **Step 3: Manual/dev verification notes in PR**

- With CPA env, open Claude provider gear → models list → Refresh → see OpenCode Go models with warning.
- Trusted Grok/GPT rows show limits, no warning.
- Touch warning on mobile simulator / compact layout shows message.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/components/provider-diagnostic-sheet.tsx packages/app/src/i18n
git commit -m "feat(app): soft capacity warning for CLIProxyAPI Claude models"
```

---

### Task 8: Docs + final verification

**Files:**

- Modify: `docs/custom-providers.md` (short section; link to design spec; do not duplicate long protocol)
- Possibly: `docs/superpowers/specs/2026-08-11-cliproxyapi-claude-code-models-design.md` only if implementation forced a tiny factual correction

- [ ] **Step 1: Document behavior**

Add a subsection under Claude custom / Anthropic base URL docs:

- When `ANTHROPIC_BASE_URL` points at CLIProxyAPI (`X-CPA-*`), Paseo appends discovered models (raw ids) on Claude catalog refresh.
- Capacity: official brands trust CPA; OpenAI-compat uses models.dev / configure warning.
- Refresh is the existing provider models Refresh button.

- [ ] **Step 2: Run final targeted checks**

```bash
cd packages/server && npx vitest run \
  src/server/agent/providers/claude/cliproxy-models.test.ts \
  src/server/agent/providers/claude/models.test.ts \
  src/server/agent/providers/claude/agent.env.test.ts \
  --bail=1

npm run typecheck
npm run lint
npm run format
```

Expected: all green

- [ ] **Step 3: Commit**

```bash
git add docs/custom-providers.md
git commit -m "docs: describe CLIProxyAPI Claude model discovery"
```

---

## Spec coverage checklist

| Spec requirement                       | Task    |
| -------------------------------------- | ------- |
| Detect CPA via credentials + `X-CPA-*` | 2, 5    |
| Anthropic `/v1/models` discovery       | 2, 5    |
| Decode `claude-fable-5-dd-*`           | 1, 2, 3 |
| Append-only merge                      | 3, 5    |
| Official `owned_by` capacity trust     | 1, 3    |
| models.dev 1 / N / 0                   | 3       |
| Auto-persist additionalModels          | 5, 6    |
| Soft warning UX + copy                 | 7       |
| Defensive `has_more` / `after_id`      | 2       |
| Claude effort defaults (not Codex)     | 3       |
| Launch env fill-if-missing             | 6       |
| Non-chat filter                        | 1, 3    |
| Docs                                   | 8       |

## Placeholder / consistency self-review

- No TBD steps; interfaces named consistently (`decodeCliproxyClaudeModelId`, `appendCliproxyModelsToClaudeCatalog`, `needsCapacityConfig`).
- `maxOutputTokens` added on protocol if missing so catalog can carry output limits.
- Auto-persist bridges catalog discovery → existing `profileModels` launch path without a second capacity cache.
