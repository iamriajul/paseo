/**
 * @vitest-environment jsdom
 */
import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentFeature, AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import { useDraftAgentFeatures } from "./use-draft-agent-features";

const { listProviderFeatures } = vi.hoisted(() => ({ listProviderFeatures: vi.fn() }));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ listProviderFeatures }),
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("./use-form-preferences", async (importActual) => ({
  ...(await importActual<typeof import("./use-form-preferences")>()),
  useFormPreferences: () => ({ preferences: {}, updatePreferences: async () => {} }),
}));

// Mirrors Claude: cache warm-up is listed only once a 5m or 1h Cache window is chosen.
function claudeFeatures(config: Pick<AgentSessionConfig, "featureValues">): AgentFeature[] {
  const ttl = config.featureValues?.prompt_cache_ttl;
  const features: AgentFeature[] = [
    {
      type: "select",
      id: "prompt_cache_ttl",
      label: "Cache window",
      value: typeof ttl === "string" ? ttl : "default",
      options: [
        { id: "default", label: "Auto" },
        { id: "5m", label: "5m" },
        { id: "1h", label: "1h" },
      ],
    },
  ];
  if (ttl === "5m" || ttl === "1h") {
    features.push({
      type: "toggle",
      id: "cache_warm",
      label: "Cache warm-up",
      value: ttl === "5m",
    });
  }
  return features;
}

function featureIds(features: AgentFeature[]): string[] {
  return features.map((feature) => feature.id);
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useDraftAgentFeatures", () => {
  // No global auto-cleanup in this app: unmount each hook so a feature fetch the last test
  // started cannot render after the file's jsdom window is torn down.
  afterEach(() => {
    cleanup();
  });

  it("lists the features the chosen values unlock and keeps the choice", async () => {
    listProviderFeatures.mockImplementation(async (config: AgentSessionConfig) => ({
      features: claudeFeatures(config),
    }));
    const { result } = renderHook(
      () =>
        useDraftAgentFeatures({
          serverId: "server-1",
          provider: "claude",
          cwd: "/repo",
          modeId: null,
          modelId: "claude-opus-5-5",
          thinkingOptionId: null,
        }),
      { wrapper },
    );

    await waitFor(() => expect(featureIds(result.current.features)).toEqual(["prompt_cache_ttl"]));

    act(() => result.current.setFeatureValue("prompt_cache_ttl", "5m"));

    await waitFor(() =>
      expect(featureIds(result.current.features)).toEqual(["prompt_cache_ttl", "cache_warm"]),
    );
    expect(listProviderFeatures).toHaveBeenLastCalledWith(
      expect.objectContaining({ featureValues: { prompt_cache_ttl: "5m" } }),
    );

    act(() => result.current.setFeatureValue("cache_warm", false));
    await waitFor(() =>
      expect(result.current.featureValues).toEqual({ prompt_cache_ttl: "5m", cache_warm: false }),
    );
  });

  it("sends a profile's feature values when it switches provider, before and after the list loads", async () => {
    let releaseCodexFeatures: () => void = () => {};
    const codexFeaturesLoaded = new Promise<void>((resolve) => {
      releaseCodexFeatures = resolve;
    });
    listProviderFeatures.mockImplementation(async (config: AgentSessionConfig) => {
      if (config.provider !== "codex") {
        return { features: claudeFeatures(config) };
      }
      await codexFeaturesLoaded;
      const features: AgentFeature[] = [
        { type: "toggle", id: "fast_mode", label: "Fast", value: false },
      ];
      return { features };
    });
    const { result, rerender } = renderHook(
      ({ provider }: { provider: string }) =>
        useDraftAgentFeatures({
          serverId: "server-1",
          provider,
          cwd: "/repo",
          modeId: null,
          modelId: null,
          thinkingOptionId: null,
        }),
      { wrapper, initialProps: { provider: "claude" } },
    );
    await waitFor(() => expect(featureIds(result.current.features)).toEqual(["prompt_cache_ttl"]));

    // Applying a profile switches provider and sets its values in one handler.
    act(() => {
      rerender({ provider: "codex" });
      result.current.applyProfileFeatureValues("codex", { fast_mode: true });
    });

    // Submitting now, while codex's list is still loading, must carry the profile's values.
    expect(result.current.features).toEqual([]);
    expect(result.current.featureValues).toEqual({ fast_mode: true });

    releaseCodexFeatures();
    await waitFor(() => expect(featureIds(result.current.features)).toEqual(["fast_mode"]));
    expect(result.current.featureValues).toEqual({ fast_mode: true });
  });

  it("drops values chosen for another provider when the draft switches away", async () => {
    listProviderFeatures.mockImplementation(async (config: AgentSessionConfig) => ({
      features: claudeFeatures(config),
    }));
    const { result, rerender } = renderHook(
      ({ provider }: { provider: string }) =>
        useDraftAgentFeatures({
          serverId: "server-1",
          provider,
          cwd: "/repo",
          modeId: null,
          modelId: null,
          thinkingOptionId: null,
        }),
      { wrapper, initialProps: { provider: "claude" } },
    );
    await waitFor(() => expect(featureIds(result.current.features)).toEqual(["prompt_cache_ttl"]));
    act(() => result.current.setFeatureValue("prompt_cache_ttl", "5m"));

    rerender({ provider: "opencode" });

    expect(result.current.featureValues).toBeUndefined();
  });
});
