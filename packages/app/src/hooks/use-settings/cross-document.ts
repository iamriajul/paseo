import type { QueryClient } from "@tanstack/react-query";
import { APP_SETTINGS_KEY } from "./keys";
import { APP_SETTINGS_QUERY_KEY } from "./storage";

interface SettingsDocumentEvents {
  addEventListener: (type: string, listener: (event: Event) => void) => void;
  removeEventListener: (type: string, listener: (event: Event) => void) => void;
}

/**
 * App settings are read from storage once and then served from the query cache, so a change
 * made by another document (a second tab, or a full-load Settings page this one was restored
 * past with Back) never reached it until a reload. Re-read when another document writes the
 * key, and when the browser restores this page from its back-forward cache, where it was
 * frozen and missed those writes.
 */
export function syncAppSettingsAcrossDocuments(input: {
  target: SettingsDocumentEvents;
  queryClient: QueryClient;
}): () => void {
  const reload = () => {
    void input.queryClient.invalidateQueries({ queryKey: APP_SETTINGS_QUERY_KEY });
  };
  const onStorage = (event: Event) => {
    const key = (event as Event & { key?: string | null }).key;
    // A null key is storage.clear(), which drops the settings too.
    if (key === APP_SETTINGS_KEY || key === null) reload();
  };
  const onPageShow = (event: Event) => {
    if ((event as Event & { persisted?: boolean }).persisted) reload();
  };
  input.target.addEventListener("storage", onStorage);
  input.target.addEventListener("pageshow", onPageShow);
  return () => {
    input.target.removeEventListener("storage", onStorage);
    input.target.removeEventListener("pageshow", onPageShow);
  };
}
