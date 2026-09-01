import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UserComposerAttachment } from "@/attachments/types";
import type { TextReplacement } from "@/composer/types";
import type { DraftAgentControlsProps } from "@/composer/agent-controls";
import type { DraftCommandConfig } from "@/hooks/use-agent-commands-query";
import {
  useAgentFormState,
  type CreateAgentInitialValues,
  type UseAgentFormStateResult,
} from "@/hooks/use-agent-form-state";
import { useDraftAgentFeatures } from "@/hooks/use-draft-agent-features";
import {
  buildDraftAgentControls,
  hasDraftContent,
  resolveDraftKey,
  type DraftKeyInput,
} from "@/composer/draft/input-draft-core";
import {
  buildDraftCommandConfig,
  resolveEffectiveComposerModelId,
  resolveEffectiveComposerThinkingOptionId,
  type ProviderSelectionState,
} from "@/provider-selection/provider-selection";
import { useHostFeature } from "@/runtime/host-features";
import { getHostRuntimeStore, useHostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import { useDraftStore } from "@/stores/draft-store";
import { useHostFeature } from "@/runtime/host-features";
import { getHostRuntimeStore, useHostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import {
  clearComposerOnHost,
  handleUiStateUpdatedForComposer,
  hydrateComposerFromHost,
  scheduleComposerHostUpsert,
} from "@/ui-state/composer-host-sync";
import { toWireComposerKey } from "@/ui-state/keys";
import { AfterPaintPublication } from "@/composer/after-paint-publication";
import { useShallow } from "zustand/shallow";
import type { ComposerTextSource } from "@/composer/text-source";
import { isWeb } from "@/constants/platform";

type AttachmentUpdater =
  | UserComposerAttachment[]
  | ((prev: UserComposerAttachment[]) => UserComposerAttachment[]);

interface AgentInputDraftComposerOptions {
  initialServerId: string | null;
  initialValues?: CreateAgentInitialValues;
  initialFeatureValues?: Record<string, unknown>;
  isVisible?: boolean;
  lockedWorkingDir?: string;
}

interface UseAgentInputDraftInput {
  draftKey: DraftKeyInput;
  composer?: AgentInputDraftComposerOptions;
}

type DraftComposerState = UseAgentFormStateResult & {
  workingDir: string;
  effectiveModelId: string;
  effectiveThinkingOptionId: string;
  featureValues: Record<string, unknown> | undefined;
  agentControls: DraftAgentControlsProps;
  commandDraftConfig: DraftCommandConfig | undefined;
};

export interface AgentInputDraft {
  textSource: ComposerTextSource;
  editText: (text: string) => void;
  replaceText: (text: string) => void;
  textReplacement: TextReplacement;
  attachments: UserComposerAttachment[];
  setAttachments: (updater: AttachmentUpdater) => void;
  clear: (lifecycle: "sent" | "abandoned") => void;
  isHydrated: boolean;
  attachmentFocusRequestId: number;
  composerState: DraftComposerState | null;
}

export function useAgentInputDraft(input: UseAgentInputDraftInput): AgentInputDraft {
  const composerOptions = input.composer ?? null;
  const workingDir = composerOptions?.lockedWorkingDir?.trim() || "";
  const formState = useAgentFormState({
    workingDir,
    serverId: composerOptions?.initialServerId ?? null,
    initialValues: composerOptions?.initialValues,
    isVisible: composerOptions?.isVisible ?? false,
    isCreateFlow: true,
  });
  const draftKey = useMemo(
    () =>
      resolveDraftKey({
        draftKey: input.draftKey,
        selectedServerId: formState.selectedServerId,
      }),
    [formState.selectedServerId, input.draftKey],
  );
  const attachments = useDraftStore(
    useShallow((state) =>
      state.drafts[draftKey]?.lifecycle === "active"
        ? (state.drafts[draftKey].input.attachments ?? [])
        : [],
    ),
  );
  const textSource = useMemo<ComposerTextSource>(
    () => ({
      getSnapshot: () => {
        const record = useDraftStore.getState().drafts[draftKey];
        return record?.lifecycle === "active" ? record.input.text : "";
      },
      subscribe: (listener) =>
        useDraftStore.subscribe((state, previous) => {
          if (
            state.drafts[draftKey]?.input.text !== previous.drafts[draftKey]?.input.text ||
            state.drafts[draftKey]?.lifecycle !== previous.drafts[draftKey]?.lifecycle
          )
            listener();
        }),
    }),
    [draftKey],
  );
  const hostServerId = useMemo(() => {
    // Prefer explicit composer server; fall back to parsing agent:/draft: keys.
    const fromComposer = composerOptions?.initialServerId?.trim();
    if (fromComposer) {
      return fromComposer;
    }
    const parts = draftKey.split(":");
    if ((parts[0] === "agent" || parts[0] === "draft") && parts[1]) {
      return parts[1];
    }
    return formState.selectedServerId?.trim() || null;
  }, [composerOptions?.initialServerId, draftKey, formState.selectedServerId]);
  const supportsUiState = useHostFeature(hostServerId, "uiState");
  const connectionStatus = useHostRuntimeConnectionStatus(hostServerId ?? "");
  const isHostOnline = connectionStatus === "online";
  const attachmentFocusRequestId = useDraftStore(
    (state) => state.attachmentFocusRequestByDraftKey[draftKey] ?? 0,
  );
  const [hydratedDraftKey, setHydratedDraftKey] = useState<string | null>(null);
  const isHydrated = hydratedDraftKey === draftKey;
  const textReplacementRevisionRef = useRef(0);
  const [textReplacement, setTextReplacement] = useState<TextReplacement>(() => ({
    key: `${draftKey}:0`,
    text: textSource.getSnapshot(),
  }));

  const publishTextReplacement = useCallback(
    (nextText: string) => {
      textReplacementRevisionRef.current += 1;
      setTextReplacement({
        key: `${draftKey}:${textReplacementRevisionRef.current}`,
        text: nextText,
      });
    },
    [draftKey],
  );

  const saveDraft = useCallback(
    (
      update: (draft: { text: string; attachments: UserComposerAttachment[] }) => {
        text: string;
        attachments: UserComposerAttachment[];
      },
    ) => {
      const store = useDraftStore.getState();
      const current = store.getDraftInput(draftKey) ?? { text: "", attachments: [] };
      const next = update(current);
      if (!hasDraftContent(next)) {
        store.clearDraftInput({ draftKey, lifecycle: "abandoned" });
        if (supportsUiState && hostServerId) {
          const client = getHostRuntimeStore().getClient(hostServerId);
          if (client) {
            void clearComposerOnHost({ client, clientDraftKey: draftKey });
          }
        }
        return;
      }
      store.saveDraftInput({ draftKey, draft: next });
      if (supportsUiState && hostServerId) {
        const client = getHostRuntimeStore().getClient(hostServerId);
        if (client) {
          scheduleComposerHostUpsert({
            client,
            clientDraftKey: draftKey,
            text: next.text,
            attachments: next.attachments,
          });
        }
      }
    },
    [draftKey, hostServerId, supportsUiState],
  );

  const textPublication = useMemo(
    () =>
      new AfterPaintPublication<string>((nextText) => {
        useDraftStore.getState().editDraftText({ draftKey, text: nextText });
      }),
    [draftKey],
  );

  const editText = useCallback(
    (nextText: string) => {
      if (isWeb) {
        textPublication.stage(nextText);
      } else {
        useDraftStore.getState().editDraftText({ draftKey, text: nextText });
      }
    },
    [draftKey, textPublication],
  );

  const replaceText = useCallback(
    (nextText: string) => {
      textPublication.cancel();
      useDraftStore.getState().editDraftText({ draftKey, text: nextText });
      publishTextReplacement(nextText);
    },
    [draftKey, publishTextReplacement, textPublication],
  );

  const setAttachments = useCallback(
    (updater: AttachmentUpdater) => {
      saveDraft((current) => ({
        ...current,
        attachments: typeof updater === "function" ? updater(current.attachments) : updater,
      }));
    },
    [saveDraft],
  );

  const clear = useCallback(
    (lifecycle: "sent" | "abandoned") => {
      textPublication.cancel();
      useDraftStore.getState().clearDraftInput({ draftKey, lifecycle });
      if (supportsUiState && hostServerId) {
        const client = getHostRuntimeStore().getClient(hostServerId);
        if (client) {
          void clearComposerOnHost({ client, clientDraftKey: draftKey });
        }
      }
    },
    [draftKey, hostServerId, supportsUiState, textPublication],
  );

  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") textPublication.flush();
    };
    const flush = () => textPublication.flush();
    const canListenForPageHide =
      isWeb && typeof window !== "undefined" && typeof window.addEventListener === "function";
    if (isWeb && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", flushWhenHidden);
    }
    if (canListenForPageHide) {
      window.addEventListener("pagehide", flush);
    }
    return () => {
      if (isWeb && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", flushWhenHidden);
      }
      if (canListenForPageHide) {
        window.removeEventListener("pagehide", flush);
      }
      textPublication.flush();
    };
  }, [textPublication]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await useDraftStore.getState().hydrateDraftInput({ draftKey });
      if (supportsUiState && isHostOnline && hostServerId && toWireComposerKey(draftKey)) {
        const client = getHostRuntimeStore().getClient(hostServerId);
        if (client) {
          try {
            await hydrateComposerFromHost({ client, clientDraftKey: draftKey });
          } catch (error) {
            console.warn("[ui-state] composer hydrate failed", error);
          }
        }
      }
      if (!cancelled) {
        const hydratedText = useDraftStore.getState().getDraftInput(draftKey)?.text ?? "";
        publishTextReplacement(hydratedText);
        setHydratedDraftKey(draftKey);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [draftKey, hostServerId, isHostOnline, supportsUiState, publishTextReplacement]);

  useEffect(() => {
    if (!supportsUiState || !isHostOnline || !hostServerId) {
      return;
    }
    const client = getHostRuntimeStore().getClient(hostServerId);
    if (!client) {
      return;
    }
    const wireKey = toWireComposerKey(draftKey);
    if (!wireKey) {
      return;
    }
    return client.on("ui_state.updated", (message) => {
      handleUiStateUpdatedForComposer({
        message,
        resolveClientDraftKeys: (key) => (key === wireKey ? [draftKey] : []),
      });
    });
  }, [draftKey, hostServerId, isHostOnline, supportsUiState]);

  const providerSelection = useMemo<ProviderSelectionState>(
    () => ({
      provider: formState.selectedProvider,
      modelId: formState.selectedModel,
      modeId: formState.selectedMode,
      thinkingOptionId: formState.selectedThinkingOptionId,
      availableModels: formState.availableModels,
      modeOptions: formState.modeOptions,
    }),
    [
      formState.availableModels,
      formState.modeOptions,
      formState.selectedMode,
      formState.selectedModel,
      formState.selectedProvider,
      formState.selectedThinkingOptionId,
    ],
  );

  const effectiveModelId = useMemo(
    () => resolveEffectiveComposerModelId(providerSelection),
    [providerSelection],
  );

  const effectiveThinkingOptionId = useMemo(
    () => resolveEffectiveComposerThinkingOptionId(providerSelection, effectiveModelId),
    [effectiveModelId, providerSelection],
  );

  const {
    features: draftFeatures,
    featureValues: draftFeatureValues,
    setFeatureValue: setDraftFeatureValue,
    applyProfileFeatureValues,
  } = useDraftAgentFeatures({
    serverId: formState.selectedServerId,
    provider: formState.selectedProvider,
    cwd: workingDir,
    modeId: formState.selectedMode,
    modelId: effectiveModelId,
    thinkingOptionId: effectiveThinkingOptionId,
    initialFeatureValues: composerOptions?.initialFeatureValues,
  });

  const applyDraftAgentProfile = useCallback(
    (profile: Parameters<typeof formState.applyProfileFromUser>[0]) => {
      formState.applyProfileFromUser(profile);
      applyProfileFeatureValues(profile.featureValues);
    },
    [applyProfileFeatureValues, formState],
  );

  const commandDraftConfig = useMemo(
    () =>
      composerOptions
        ? buildDraftCommandConfig({
            selection: providerSelection,
            cwd: workingDir,
            effectiveModelId,
            effectiveThinkingOptionId,
            featureValues: draftFeatureValues,
          })
        : undefined,
    [
      composerOptions,
      effectiveModelId,
      effectiveThinkingOptionId,
      draftFeatureValues,
      providerSelection,
      workingDir,
    ],
  );

  const composerState = useMemo<DraftComposerState | null>(() => {
    if (!composerOptions) {
      return null;
    }

    return {
      ...formState,
      workingDir,
      effectiveModelId,
      effectiveThinkingOptionId,
      featureValues: draftFeatureValues,
      agentControls: buildDraftAgentControls({
        formState,
        features: draftFeatures,
        onSetFeature: setDraftFeatureValue,
        onApplyAgentProfile: applyDraftAgentProfile,
      }),
      commandDraftConfig,
    };
  }, [
    commandDraftConfig,
    composerOptions,
    effectiveModelId,
    effectiveThinkingOptionId,
    draftFeatures,
    draftFeatureValues,
    applyDraftAgentProfile,
    formState,
    setDraftFeatureValue,
    workingDir,
  ]);

  return {
    textSource,
    editText,
    replaceText,
    textReplacement,
    attachments,
    setAttachments,
    clear,
    isHydrated,
    attachmentFocusRequestId,
    composerState,
  };
}

export const __private__ = {
  resolveDraftKey,
  resolveEffectiveComposerModelId,
  resolveEffectiveComposerThinkingOptionId,
  buildDraftCommandConfig,
  buildDraftComposerCommandConfig: buildDraftCommandConfig,
  buildDraftAgentControls,
};
