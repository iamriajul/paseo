import { useCallback, useEffect, useRef, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ServerBrowserElementSelection } from "@getpaseo/protocol/server-browser/rpc-schemas";
import { persistAttachmentFromDataUrl } from "@/attachments/service";
import type { AttachmentMetadata } from "@/attachments/types";
import { useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import {
  buildBrowserAttachmentScopeKey,
  buildBrowserElementAttachment,
  type BrowserElementAnnotation,
  type BrowserElementSelection,
} from "@/desktop/browser/browser-element-attachment";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";

// The daemon returns the selector script's payload unchanged, so it is a BrowserElementSelection.
const asSelection = (selection: ServerBrowserElementSelection): BrowserElementSelection =>
  selection;

export type ServerBrowserAnnotateState =
  | { status: "idle" }
  | { status: "picking" }
  | {
      status: "composing";
      selection: BrowserElementSelection;
      screenshot: AttachmentMetadata | undefined;
    };

export interface ServerBrowserAnnotate {
  state: ServerBrowserAnnotateState;
  toggle(): void;
  cancel(): void;
  submit(annotation: BrowserElementAnnotation): void;
  dismiss(): void;
}

/**
 * Annotate element on a server browser tab. While picking, the surface sends pointer moves and the
 * click as ordinary input; the selector the daemon armed in the page highlights and picks.
 */
export function useServerBrowserAnnotate(input: {
  client: DaemonClient | null;
  serverId: string;
  workspaceId: string;
  browserId: string;
  onError: (message: string) => void;
}): ServerBrowserAnnotate {
  const { client, serverId, workspaceId, browserId, onError } = input;
  const [state, setState] = useState<ServerBrowserAnnotateState>({ status: "idle" });
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const addWorkspaceAttachment = useWorkspaceAttachmentsStore(
    (store) => store.addWorkspaceAttachment,
  );
  // Each start gets a token, so a pick answered after a newer start (or unmount) is ignored.
  const runRef = useRef(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const cancel = useCallback(() => {
    if (!client) return;
    void client.serverBrowserCancelAnnotate(browserId).catch(() => {});
  }, [browserId, client]);

  const start = useCallback(() => {
    if (!client) return;
    const run = ++runRef.current;
    setState({ status: "picking" });
    void (async () => {
      try {
        const result = await client.serverBrowserAnnotate(browserId);
        if (run !== runRef.current) return;
        if (result.outcome !== "selected" || !result.selection) {
          setState({ status: "idle" });
          return;
        }
        const selection = asSelection(result.selection);
        const screenshot = result.screenshot
          ? await persistAttachmentFromDataUrl({
              dataUrl: `data:${result.screenshot.mimeType};base64,${result.screenshot.data}`,
              mimeType: result.screenshot.mimeType,
              fileName: `element-${selection.tag}.png`,
            }).catch(() => undefined)
          : undefined;
        if (run !== runRef.current) return;
        setState({ status: "composing", selection, screenshot });
      } catch (caught) {
        if (run !== runRef.current) return;
        setState({ status: "idle" });
        onErrorRef.current(caught instanceof Error ? caught.message : String(caught));
      }
    })();
  }, [browserId, client]);

  const toggle = useCallback(() => {
    if (state.status === "picking") cancel();
    else start();
  }, [cancel, start, state.status]);

  const dismiss = useCallback(() => {
    runRef.current += 1;
    setState({ status: "idle" });
  }, []);

  const submit = useCallback(
    (annotation: BrowserElementAnnotation) => {
      if (state.status !== "composing") return;
      dismiss();
      const scopeKey = buildBrowserAttachmentScopeKey({ cwd, serverId, workspaceId });
      if (!scopeKey) return;
      addWorkspaceAttachment({
        scopeKey,
        attachment: {
          kind: "browser_element",
          attachment: buildBrowserElementAttachment(state.selection, annotation, state.screenshot),
        },
      });
    },
    [addWorkspaceAttachment, cwd, dismiss, serverId, state, workspaceId],
  );

  // Leaving the tab (or switching tabs) must not leave the page armed for nobody.
  const pickingRef = useRef(false);
  pickingRef.current = state.status === "picking";
  useEffect(
    () => () => {
      runRef.current += 1;
      if (pickingRef.current) cancel();
    },
    [cancel],
  );

  return { state, toggle, cancel, submit, dismiss };
}
