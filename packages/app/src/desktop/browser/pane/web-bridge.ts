import { z } from "zod";

// The parent half of the bridge the daemon injects into proxied HTML
// (packages/server/src/server/browser-preview/inject/). Web-only: the preview
// iframe exists in index.web.tsx and nowhere else.

const BRIDGE_SOURCE = "paseo-browser-bridge";
const COMMAND_SOURCE = "paseo-browser";

const NavigationPayloadSchema = z.object({
  docId: z.string(),
  seq: z.number(),
  url: z.string(),
  title: z.string(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
});

// Field-for-field BrowserElementSelection, so buildBrowserElementAttachment
// consumes a selection with no shim.
const SelectionPayloadSchema = z.object({
  url: z.string(),
  selector: z.string(),
  tag: z.string(),
  text: z.string(),
  outerHTML: z.string(),
  computedStyles: z.record(z.string(), z.string()),
  boundingRect: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }),
  reactSource: z
    .object({
      fileName: z.string().nullable(),
      lineNumber: z.number().nullable(),
      columnNumber: z.number().nullable(),
      componentName: z.string().nullable(),
    })
    .nullable(),
  parentChain: z.array(z.string()),
  children: z.array(z.string()),
});

const MessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), payload: z.object({ docId: z.string() }) }),
  z.object({ type: z.literal("navigation"), payload: NavigationPayloadSchema }),
  z.object({ type: z.literal("selection"), payload: SelectionPayloadSchema }),
  z.object({ type: z.literal("select-cancelled"), payload: z.unknown() }),
  z.object({ type: z.literal("eruda-ready"), payload: z.unknown() }),
  // The injected script sends `{}` today. `reason` is declared here so a later
  // daemon can say which of the three ways the eruda load failed without also
  // needing an app release to surface it — an older app on a newer daemon is
  // the drift this repo's protocol rules are written for.
  z.object({
    type: z.literal("eruda-failed"),
    payload: z.object({ reason: z.string().optional() }).optional(),
  }),
]);

export type BridgeSelection = z.infer<typeof SelectionPayloadSchema>;

export type BridgeEvent =
  | { type: "ready"; docId: string }
  | ({ type: "navigation" } & z.infer<typeof NavigationPayloadSchema>)
  | { type: "selection"; selection: BridgeSelection }
  | { type: "select-cancelled" }
  | { type: "eruda-ready" }
  | { type: "eruda-failed"; reason?: string };

export type BridgeCommand =
  | { command: "back" | "forward" | "reload" | "toggle-eruda" | "start-select" | "cancel-select" }
  | { command: "goto"; url: string };

export interface PreviewBridge {
  /**
   * Posts a command to the previewed document, targeted at the preview origin.
   *
   * `goto` is deliberately **not** constrained to the preview origin. It would
   * buy no security — the caller already owns the iframe's `src`, a strictly
   * stronger capability than asking the frame to navigate — and the injected
   * script fails closed on anything that isn't http(s), which is the check that
   * matters. Routing policy (preview origin vs direct) lives in
   * `resolveWebBrowserSrc`; deciding it a second time here would give one rule
   * two homes to drift between.
   *
   * The consequence at this call site: **a cross-origin `goto` ends the bridge
   * session.** The proxy injects no bridge into another origin and
   * `event.origin` stops matching, so the frame goes on rendering while
   * back/forward/reload/devtools/select all fall silent with no error. Send an
   * address-bar URL through `resolveWebBrowserSrc` and re-point the iframe
   * instead; reserve `goto` for navigation you know stays on the preview origin.
   */
  send(command: BridgeCommand): void;
  dispose(): void;
}

export function createPreviewBridge(options: {
  origin: string;
  getFrame: () => Window | null;
  onEvent: (event: BridgeEvent) => void;
  listenTarget?: Window;
}): PreviewBridge {
  const target = options.listenTarget ?? window;

  const handleMessage = (event: MessageEvent): void => {
    // Both checks matter: origin alone would accept any frame served by the
    // preview host, and source alone would accept a frame that navigated away.
    if (event.origin !== options.origin) return;
    // `!frame` is not redundant: with the iframe unmounted getFrame() is null,
    // and a worker or service-worker message also has a null source, so the
    // identity check alone would match them to each other.
    const frame = options.getFrame();
    if (!frame || event.source !== frame) return;

    const data = event.data as { source?: unknown } | null;
    if (!data || data.source !== BRIDGE_SOURCE) return;

    const parsed = MessageSchema.safeParse(data);
    if (!parsed.success) return;

    switch (parsed.data.type) {
      case "ready":
        options.onEvent({ type: "ready", docId: parsed.data.payload.docId });
        return;
      case "navigation":
        options.onEvent({ type: "navigation", ...parsed.data.payload });
        return;
      case "selection":
        options.onEvent({ type: "selection", selection: parsed.data.payload });
        return;
      case "select-cancelled":
        options.onEvent({ type: "select-cancelled" });
        return;
      case "eruda-ready":
        options.onEvent({ type: "eruda-ready" });
        return;
      case "eruda-failed": {
        const reason = parsed.data.payload?.reason;
        options.onEvent(reason ? { type: "eruda-failed", reason } : { type: "eruda-failed" });
        return;
      }
    }

    // The switch above has no default, so a seventh member added to
    // MessageSchema would fall through to here and be dropped in silence. This
    // assignment is what makes that a compile error instead: `parsed.data` is
    // `never` only while every member has a case. `noImplicitReturns` is off
    // repo-wide, so nothing else catches it.
    const unhandled: never = parsed.data;
    void unhandled;
  };

  target.addEventListener("message", handleMessage);

  return {
    send(command) {
      options.getFrame()?.postMessage({ source: COMMAND_SOURCE, ...command }, options.origin);
    },
    dispose() {
      target.removeEventListener("message", handleMessage);
    },
  };
}
