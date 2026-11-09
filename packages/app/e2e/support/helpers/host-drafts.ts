import type { SeedDaemonClient } from "./seed-client";

const NAMESPACES = ["composer", "review"] as const;

/**
 * Fork composer-draft-sync saves drafts on the host, and the worker daemon outlives each test's
 * browser context. A draft one test leaves (the global composer's key is always `new-workspace`)
 * would be restored into the next test's composer while it types. Every test starts with none,
 * as it would with official's browser-only drafts.
 */
export async function clearSavedHostDrafts(client: SeedDaemonClient): Promise<void> {
  const updatedAt = new Date().toISOString();
  for (const namespace of NAMESPACES) {
    const { entries, error } = await client.listUiState({ namespace });
    if (error) throw new Error(`Listing saved ${namespace} drafts failed: ${error}`);
    for (const { key } of entries) {
      await client.clearUiState({ namespace, key, updatedAt });
    }
  }
}
