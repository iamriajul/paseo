import { create } from "zustand";

interface ProviderSettingsTarget {
  serverId: string;
  provider: string;
  overlayParentLayer?: number;
  configureModelId?: string;
}

interface ProviderSettingsStoreState {
  serverId: string | null;
  provider: string | null;
  overlayParentLayer: number;
  configureModelId: string | null;
  visible: boolean;
  open: (target: ProviderSettingsTarget) => void;
  close: () => void;
  consumeConfigureModelId: () => string | null;
}

export const useProviderSettingsStore = create<ProviderSettingsStoreState>()((set, get) => ({
  serverId: null,
  provider: null,
  overlayParentLayer: 0,
  configureModelId: null,
  visible: false,
  open: ({ serverId, provider, overlayParentLayer = 0, configureModelId = undefined }) => {
    set({
      serverId,
      provider,
      overlayParentLayer,
      configureModelId: configureModelId ?? null,
      visible: true,
    });
  },
  close: () => {
    set({ visible: false, configureModelId: null });
  },
  consumeConfigureModelId: () => {
    const modelId = get().configureModelId;
    if (modelId) set({ configureModelId: null });
    return modelId;
  },
}));
