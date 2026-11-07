import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AgentProvider, AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { mergeProviderPreferences, useFormPreferences } from "./use-form-preferences";
import {
  applyFeatureValues,
  pruneFeatureValues,
  resolveFeatureValues,
} from "./feature-preferences";

// Values the user (or an applied profile) chose in this draft, tagged with the provider they
// were chosen for. A provider switch makes them inapplicable instead of erasing them, so a
// profile that switches provider and sets its values in one handler keeps them. `null` adopts
// the first provider the draft resolves to (restored values arrive before the provider does).
interface LocalFeatureValues {
  provider: AgentProvider | null;
  values: Record<string, unknown>;
}

const NO_FEATURE_VALUES: Record<string, unknown> = {};

type DraftFeatureConfig = Pick<
  AgentSessionConfig,
  "provider" | "cwd" | "modeId" | "model" | "thinkingOptionId" | "featureValues"
>;

export function useDraftAgentFeatures(input: {
  serverId: string | null | undefined;
  provider: AgentProvider | null;
  cwd: string | null | undefined;
  modeId: string | null | undefined;
  modelId: string | null | undefined;
  thinkingOptionId: string | null | undefined;
  initialFeatureValues?: Record<string, unknown>;
}) {
  const { t } = useTranslation();
  const { serverId, provider, cwd, modeId, modelId, thinkingOptionId, initialFeatureValues } =
    input;
  const [localState, setLocalState] = useState<LocalFeatureValues>(() => ({
    provider: null,
    values: initialFeatureValues ?? {},
  }));
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const { preferences, updatePreferences } = useFormPreferences();
  const normalizedCwd = cwd?.trim() || "";
  const normalizedProvider = provider ?? null;
  const localFeatureValues =
    localState.provider === null || localState.provider === normalizedProvider
      ? localState.values
      : NO_FEATURE_VALUES;
  const persistedFeatureValues = useMemo(
    () => (provider ? (preferences.providerPreferences?.[provider]?.featureValues ?? {}) : {}),
    [preferences.providerPreferences, provider],
  );

  // The provider decides which features exist from the values chosen so far (Claude lists
  // cache warm-up only for a 5m or 1h Cache window), so the request carries them. They come
  // from the user's inputs, not from the listed features, so the query cannot feed itself.
  const requestedFeatureValues = useMemo(
    () => ({ ...persistedFeatureValues, ...localFeatureValues }),
    [localFeatureValues, persistedFeatureValues],
  );

  const draftConfig = useMemo<DraftFeatureConfig | null>(() => {
    if (!normalizedProvider || !normalizedCwd) {
      return null;
    }

    return {
      provider: normalizedProvider,
      cwd: normalizedCwd,
      ...(modeId ? { modeId } : {}),
      ...(modelId ? { model: modelId } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(Object.keys(requestedFeatureValues).length > 0
        ? { featureValues: requestedFeatureValues }
        : {}),
    };
  }, [
    modeId,
    modelId,
    normalizedCwd,
    normalizedProvider,
    requestedFeatureValues,
    thinkingOptionId,
  ]);

  const draftKey = [
    serverId ?? null,
    normalizedProvider,
    normalizedCwd || null,
    modeId ?? null,
    modelId ?? null,
    thinkingOptionId ?? null,
  ] as const;
  const featuresQuery = useQuery({
    queryKey: ["providerFeatures", ...draftKey, draftConfig?.featureValues ?? null],
    enabled: Boolean(serverId && client && isConnected && draftConfig),
    staleTime: 5 * 60 * 1000,
    // A changed feature value refetches; keep the same draft's controls on screen meanwhile,
    // but never another provider's or model's.
    placeholderData: (previous, previousQuery) =>
      previousQuery && isSameDraft(previousQuery.queryKey, draftKey) ? previous : undefined,
    queryFn: async () => {
      if (!client || !draftConfig) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.listProviderFeatures(draftConfig);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.features ?? [];
    },
  });
  const availableFeaturesRaw = featuresQuery.data;
  const availableFeatures = useMemo(() => availableFeaturesRaw ?? [], [availableFeaturesRaw]);
  const featureValues = useMemo(
    () =>
      resolveFeatureValues({
        features: availableFeaturesRaw ?? null,
        persistedFeatureValues,
        localFeatureValues,
      }),
    [availableFeaturesRaw, localFeatureValues, persistedFeatureValues],
  );

  const features = useMemo(() => {
    return applyFeatureValues(availableFeatures, featureValues);
  }, [availableFeatures, featureValues]);

  useEffect(() => {
    if (normalizedProvider === null) {
      return;
    }
    setLocalState((current) => {
      if (current.provider === normalizedProvider) {
        return current;
      }
      return {
        provider: normalizedProvider,
        values: current.provider === null ? current.values : {},
      };
    });
  }, [normalizedProvider]);

  useEffect(() => {
    // Placeholder data is the previous request's list; pruning against it could drop a value
    // the pending list adds back.
    if (availableFeaturesRaw === undefined || featuresQuery.isPlaceholderData) {
      return;
    }
    const next = pruneFeatureValues(localFeatureValues, availableFeatures);
    if (next !== localFeatureValues) {
      setLocalState({ provider: normalizedProvider, values: next });
    }
  }, [
    availableFeatures,
    availableFeaturesRaw,
    featuresQuery.isPlaceholderData,
    localFeatureValues,
    normalizedProvider,
  ]);

  const effectiveFeatureValues = Object.keys(featureValues).length > 0 ? featureValues : undefined;
  const setFeatureValue = useCallback(
    (featureId: string, value: unknown) => {
      if (!provider) {
        return;
      }
      setLocalState((current) => {
        const values = current.provider === provider ? current.values : {};
        if (current.provider === provider && Object.is(values[featureId], value)) {
          return current;
        }

        return { provider, values: { ...values, [featureId]: value } };
      });
      void updatePreferences((current) =>
        mergeProviderPreferences({
          preferences: current,
          provider,
          updates: {
            featureValues: {
              [featureId]: value,
            },
          },
        }),
      ).catch((error) => {
        console.warn("[useDraftAgentFeatures] persist feature preference failed", error);
      });
    },
    [provider, updatePreferences],
  );

  const applyProfileFeatureValues = useCallback(
    (profileProvider: AgentProvider, values: Record<string, unknown>) => {
      setLocalState({ provider: profileProvider, values });
    },
    [],
  );

  return {
    features,
    featureValues: effectiveFeatureValues,
    isLoading: featuresQuery.isLoading,
    setFeatureValue,
    applyProfileFeatureValues,
  };
}

function isSameDraft(queryKey: readonly unknown[], draftKey: readonly unknown[]): boolean {
  return draftKey.every((part, index) => Object.is(queryKey[index + 1], part));
}
