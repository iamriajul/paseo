import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceScriptPayload } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";
import {
  findMainPreviewService,
  isServiceOpenable,
  listWorkspaceServices,
  stepPendingServiceOpen,
  type PendingServiceOpen,
} from "./workspace-services";

const EMPTY_SCRIPTS: WorkspaceScriptPayload[] = [];

export interface WorkspaceServices {
  services: WorkspaceScriptPayload[];
  /** The service paseo.json marks `"preview": true`, if any. */
  previewService: WorkspaceScriptPayload | null;
}

/** The workspace's paseo.json services, live from the session store. */
export function useWorkspaceServices(serverId: string, workspaceId: string): WorkspaceServices {
  const scripts = useSessionStore(
    (state) => state.sessions[serverId]?.workspaces?.get(workspaceId)?.scripts ?? EMPTY_SCRIPTS,
  );
  return useMemo(
    () => ({
      services: listWorkspaceServices(scripts),
      previewService: findMainPreviewService(scripts),
    }),
    [scripts],
  );
}

export interface WorkspaceServiceOpener {
  /** Opens a running service now; starts a stopped one and opens it once it runs. */
  open: (scriptName: string) => void;
  /** The service waiting to start before it opens. */
  pendingScriptName: string | null;
}

/**
 * Start-then-open for paseo.json services, shared by every surface that opens one:
 * the Browser's services menu, the scripts menu and the header's preview action.
 * `onOpen` decides where the service goes (a Browser tab, an external browser).
 *
 * The wait outlives the press, so mount this with whatever owns the menu rather
 * than inside a menu row that unmounts when the menu closes.
 */
export function useWorkspaceServiceOpener(input: {
  scripts: readonly WorkspaceScriptPayload[];
  start: (scriptName: string, options?: { onError?: () => void }) => void;
  onOpen: (service: WorkspaceScriptPayload) => void;
}): WorkspaceServiceOpener {
  const { scripts, start } = input;
  const [pending, setPending] = useState<PendingServiceOpen | null>(null);
  const onOpenRef = useRef(input.onOpen);
  onOpenRef.current = input.onOpen;
  const scriptsRef = useRef(scripts);
  scriptsRef.current = scripts;

  useEffect(() => {
    if (!pending) {
      return;
    }
    const step = stepPendingServiceOpen(pending, scripts);
    if (step.kind === "open") {
      setPending(null);
      onOpenRef.current(step.service);
    } else if (step.kind === "drop") {
      setPending(null);
    } else if (step.pending !== pending) {
      setPending(step.pending);
    }
  }, [pending, scripts]);

  const open = useCallback(
    (scriptName: string) => {
      const service = scriptsRef.current.find((script) => script.scriptName === scriptName);
      if (!service) {
        return;
      }
      if (isServiceOpenable(service)) {
        setPending(null);
        onOpenRef.current(service);
        return;
      }
      setPending({ scriptName, sawRunning: false });
      if (service.lifecycle !== "running") {
        start(scriptName, {
          onError: () =>
            setPending((current) => (current?.scriptName === scriptName ? null : current)),
        });
      }
    },
    [start],
  );

  return useMemo(
    () => ({ open, pendingScriptName: pending?.scriptName ?? null }),
    [open, pending?.scriptName],
  );
}
