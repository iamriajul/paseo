import type { DaemonConfigStore, MutableDaemonConfig } from "../daemon-config-store.js";
import {
  mergeAdditionalModelLimits,
  type CliproxyAdditionalModelLimits,
} from "./providers/claude/cliproxy-models.js";

type MutableAdditionalModel = NonNullable<
  MutableDaemonConfig["providers"][string]["additionalModels"]
>[number];

export interface AdditionalModelLimitsPersistence {
  persistClaudeAdditionalModelLimits: (
    models: readonly CliproxyAdditionalModelLimits[],
  ) => void | Promise<void>;
}

/**
 * Build the daemon-config persistence for auto-resolved Claude capacity.
 *
 * Lives outside the generic bootstrap module so the bootstrap file stays free
 * of provider hook ids (see claude.test.ts "keeps provider names out of the
 * generic server bootstrap").
 */
export function createAdditionalModelLimitsPersistence(
  store: DaemonConfigStore,
): AdditionalModelLimitsPersistence {
  return {
    persistClaudeAdditionalModelLimits: async (models) => {
      const current = store.get();
      const existing = current.providers?.claude?.additionalModels ?? [];
      const merged = mergeAdditionalModelLimits(existing, models);
      if (merged !== existing) {
        store.patch(
          {
            providers: {
              claude: {
                additionalModels: merged.map(
                  (model) =>
                    Object.assign({}, model, {
                      label: model.label ?? model.id,
                    }) as MutableAdditionalModel,
                ),
              },
            },
          },
          { preserveInFlightProviderLoads: ["claude"] },
        );
      }
    },
  };
}
