import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  buildCodexCatalog,
  clearCachedBundledCodexModels,
  CODEX_MODEL_CATALOG_FILENAME,
  normalizeCodexCatalogModel,
  resolveCodexModelCatalogPath,
  writeCodexCatalogJsonFile,
} from "./codex-catalog.js";

describe("normalizeCodexCatalogModel", () => {
  test("returns null for non-object or missing slug", () => {
    expect(normalizeCodexCatalogModel(null)).toBeNull();
    expect(normalizeCodexCatalogModel("not-object")).toBeNull();
    expect(normalizeCodexCatalogModel({})).toBeNull();
    expect(normalizeCodexCatalogModel({ slug: "" })).toBeNull();
    expect(normalizeCodexCatalogModel({ slug: "   " })).toBeNull();
  });

  test("fills defaults from base template and computes 1M context limits", () => {
    const normalized = normalizeCodexCatalogModel({
      slug: "claude-opus-4-8",
      display_name: "Claude Opus 4.8",
      context_window: 1_000_000,
      max_context_window: 1_000_000,
    });

    expect(normalized).toMatchObject({
      slug: "claude-opus-4-8",
      display_name: "Claude Opus 4.8",
      context_window: 1_000_000,
      max_context_window: 1_000_000,
      effective_context_window_percent: 100,
      shell_type: "unified_exec",
      visibility: "list",
      supported_in_api: true,
      priority: 1,
    });
  });

  test("expands context_window to max_context_window when max is larger", () => {
    const normalized = normalizeCodexCatalogModel({
      slug: "gpt-5.4",
      display_name: "GPT 5.4",
      context_window: 272_000,
      max_context_window: 1_000_000,
    });

    expect(normalized).toMatchObject({
      slug: "gpt-5.4",
      context_window: 1_000_000,
      max_context_window: 1_000_000,
      effective_context_window_percent: 100,
    });
  });

  test("uses default 95% effective context for sub-1M models", () => {
    const normalized = normalizeCodexCatalogModel({
      slug: "small-model",
      context_window: 128_000,
    });

    expect(normalized).toMatchObject({
      slug: "small-model",
      context_window: 128_000,
      max_context_window: 128_000,
      effective_context_window_percent: 95,
    });
  });
});

describe("buildCodexCatalog", () => {
  test("merges bundled models and gateway models with gateway precedence", () => {
    const bundled = [
      {
        slug: "gpt-6-astra",
        display_name: "GPT 6 Astra",
        context_window: 272_000,
        max_context_window: 872_000,
      },
      {
        slug: "gpt-5.4",
        display_name: "GPT 5.4",
        context_window: 272_000,
        max_context_window: 1_000_000,
      },
    ];

    const gateway = [
      {
        slug: "gpt-5.4",
        display_name: "GPT 5.4 (gateway)",
        context_window: 1_000_000,
        max_context_window: 1_000_000,
      },
      {
        slug: "qwen3.8-max",
        display_name: "Qwen 3.8 Max",
        context_window: 1_000_000,
        max_context_window: 1_000_000,
      },
    ];

    const catalog = buildCodexCatalog({ gatewayModels: gateway, bundledModels: bundled });
    const bySlug = new Map(catalog.models.map((m) => [m.slug, m]));

    expect(catalog.models).toHaveLength(3);

    // gpt-6-astra from bundled: context_window expanded to max_context_window 872k
    expect(bySlug.get("gpt-6-astra")).toMatchObject({
      slug: "gpt-6-astra",
      context_window: 872_000,
      max_context_window: 872_000,
    });

    // gpt-5.4 from gateway: gateway definition wins
    expect(bySlug.get("gpt-5.4")).toMatchObject({
      slug: "gpt-5.4",
      display_name: "GPT 5.4 (gateway)",
      context_window: 1_000_000,
      max_context_window: 1_000_000,
      effective_context_window_percent: 100,
    });

    // qwen3.8-max from gateway
    expect(bySlug.get("qwen3.8-max")).toMatchObject({
      slug: "qwen3.8-max",
      context_window: 1_000_000,
      max_context_window: 1_000_000,
      effective_context_window_percent: 100,
    });
  });
});

describe("writeCodexCatalogJsonFile and resolveCodexModelCatalogPath", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-codex-catalog-test-"));
    clearCachedBundledCodexModels();
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  test("writes catalog file and resolves it", () => {
    expect(resolveCodexModelCatalogPath({ paseoHome: tempHome })).toBeNull();

    const catalog = {
      models: [
        {
          slug: "qwen3.8-max",
          display_name: "Qwen 3.8 Max",
          context_window: 1_000_000,
          max_context_window: 1_000_000,
        },
      ],
    };

    const writtenPath = writeCodexCatalogJsonFile({ catalog, paseoHome: tempHome });
    expect(writtenPath).toBe(path.join(tempHome, CODEX_MODEL_CATALOG_FILENAME));
    expect(fs.existsSync(writtenPath)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(writtenPath, "utf8"));
    expect(parsed.models[0].slug).toBe("qwen3.8-max");

    const resolved = resolveCodexModelCatalogPath({ paseoHome: tempHome });
    expect(resolved).toBe(writtenPath);
  });
});
