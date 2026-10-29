/**
 * @vitest-environment jsdom
 */
import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
        { id: "default", label: "Automatic" },
        { id: "5m", label: "5 minutes" },
        { id: "1h", label: "1 hour" },
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
});
