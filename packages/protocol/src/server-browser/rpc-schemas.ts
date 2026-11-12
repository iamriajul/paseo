import { z } from "zod";

// Server browser: a headless Chromium the daemon runs, viewed and driven from any client.
// Gated on server_info.features.serverBrowser; enabled per host by daemon config serverBrowser.enabled.

export const ServerBrowserTabSchema = z.object({
  browserId: z.string(),
  workspaceId: z.string(),
  url: z.string(),
  title: z.string(),
  isLoading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  viewport: z.object({
    width: z.number(),
    height: z.number(),
    mobile: z.boolean(),
  }),
  /** "agent" when browser_new_tab created it, "user" when a client opened it. */
  openedBy: z.enum(["agent", "user"]),
  createdAt: z.number(),
  /** The tab whose page opened this one (window.open, a target=_blank link). */
  openerBrowserId: z.string().optional(),
  /** The page's <input type=file> asked for files; a viewer picks them on its own device. */
  fileChooser: z.object({ id: z.string(), multiple: z.boolean() }).optional(),
  /** A dialog the page opened (alert, confirm, prompt, beforeunload) waiting for a viewer's answer. */
  dialog: z
    .object({
      id: z.string(),
      type: z.string(),
      message: z.string(),
      defaultPrompt: z.string().optional(),
      url: z.string(),
    })
    .optional(),
  /** The main frame's last load failed: the URL it tried and Chromium's error (net::ERR_…). */
  loadError: z.object({ url: z.string(), errorText: z.string().optional() }).optional(),
  /**
   * The tab sat idle and its page was unloaded to free memory; url, title and the last frame stay.
   * Viewing or using it reloads the page at the same URL. Needs features.serverBrowserSuspend; an
   * older app shows it as a normal tab, which reloads when used.
   */
  suspended: z.boolean().optional(),
});
export type ServerBrowserTab = z.infer<typeof ServerBrowserTabSchema>;

export const ServerBrowserStatusSchema = z.object({
  enabled: z.boolean(),
  /** Why the browser cannot run on this host (no Chromium found, launch failure). */
  unavailableReason: z.string().optional(),
  /**
   * The engine this host runs tabs in. `sharedStorage`: every workspace shares one cookie jar
   * (the browser's own profile), so there is no per-workspace data to clear.
   */
  engine: z
    .object({
      kind: z.string(),
      sharedStorage: z.boolean(),
    })
    .optional(),
});
export type ServerBrowserStatus = z.infer<typeof ServerBrowserStatusSchema>;

const ErrorField = z.string().optional();

export const ServerBrowserTabsSubscribeRequestSchema = z.object({
  type: z.literal("browser.server.tabs.subscribe.request"),
  requestId: z.string(),
});
export const ServerBrowserTabsSubscribeResponseSchema = z.object({
  type: z.literal("browser.server.tabs.subscribe.response"),
  payload: z.object({
    requestId: z.string(),
    subscriptionId: z.string(),
    tabs: z.array(ServerBrowserTabSchema),
    status: ServerBrowserStatusSchema,
  }),
});
export const ServerBrowserTabsUpdateSchema = z.object({
  type: z.literal("browser.server.tabs.update"),
  payload: z.object({
    subscriptionId: z.string().optional(),
    tabs: z.array(ServerBrowserTabSchema),
    status: ServerBrowserStatusSchema,
  }),
});

export const ServerBrowserTabOpenRequestSchema = z.object({
  type: z.literal("browser.server.tab.open.request"),
  requestId: z.string(),
  workspaceId: z.string(),
  url: z.string(),
});
export const ServerBrowserTabOpenResponseSchema = z.object({
  type: z.literal("browser.server.tab.open.response"),
  payload: z.object({
    requestId: z.string(),
    browserId: z.string().optional(),
    error: ErrorField,
  }),
});

export const ServerBrowserTabCloseRequestSchema = z.object({
  type: z.literal("browser.server.tab.close.request"),
  requestId: z.string(),
  browserId: z.string(),
});
export const ServerBrowserTabCloseResponseSchema = z.object({
  type: z.literal("browser.server.tab.close.response"),
  payload: z.object({ requestId: z.string(), error: ErrorField }),
});

// "stop" needs features.serverBrowserViewerControls.
export const ServerBrowserNavigateActionSchema = z.enum([
  "url",
  "back",
  "forward",
  "reload",
  "stop",
]);
export const ServerBrowserTabNavigateRequestSchema = z.object({
  type: z.literal("browser.server.tab.navigate.request"),
  requestId: z.string(),
  browserId: z.string(),
  action: ServerBrowserNavigateActionSchema,
  url: z.string().optional(),
});
export const ServerBrowserTabNavigateResponseSchema = z.object({
  type: z.literal("browser.server.tab.navigate.response"),
  payload: z.object({ requestId: z.string(), error: ErrorField }),
});

export const ServerBrowserTabSetViewportRequestSchema = z.object({
  type: z.literal("browser.server.tab.set_viewport.request"),
  requestId: z.string(),
  browserId: z.string(),
  width: z.number().int().min(200).max(4000),
  height: z.number().int().min(200).max(4000),
  mobile: z.boolean(),
});
export const ServerBrowserTabSetViewportResponseSchema = z.object({
  type: z.literal("browser.server.tab.set_viewport.response"),
  payload: z.object({ requestId: z.string(), error: ErrorField }),
});

export const ServerBrowserWorkspaceClearDataRequestSchema = z.object({
  type: z.literal("browser.server.workspace.clear_data.request"),
  requestId: z.string(),
  workspaceId: z.string(),
});
export const ServerBrowserWorkspaceClearDataResponseSchema = z.object({
  type: z.literal("browser.server.workspace.clear_data.response"),
  payload: z.object({ requestId: z.string(), error: ErrorField }),
});

export const ServerBrowserScreencastStartRequestSchema = z.object({
  type: z.literal("browser.server.screencast.start.request"),
  requestId: z.string(),
  browserId: z.string(),
  /** Device pixels the viewer can show; the daemon caps both at 1600. */
  maxWidth: z.number().int().positive(),
  maxHeight: z.number().int().positive(),
  /**
   * The viewer decodes video: codecs it can decode, best first (WebCodecs codec strings).
   * Needs features.serverBrowserVideo; the daemon answers with `video` when it streams video.
   */
  video: z.object({ codecs: z.array(z.string()) }).optional(),
});
export const ServerBrowserScreencastStartResponseSchema = z.object({
  type: z.literal("browser.server.screencast.start.response"),
  payload: z.object({
    requestId: z.string(),
    /** Release with subscription.release.request to stop the stream. */
    subscriptionId: z.string().optional(),
    /** Matches the streamId of binary Frame (0x40), VideoChunk (0x42) and FrameAck (0x41) frames. */
    streamId: z.number().int().optional(),
    /**
     * Present when the stream sends VideoChunk frames in this codec. JPEG Frames may still arrive
     * (before the first keyframe, or after the capture failed); show whichever came last.
     */
    video: z.object({ codec: z.string() }).optional(),
    error: ErrorField,
  }),
});

const ModifiersSchema = z.array(z.enum(["Alt", "Control", "Meta", "Shift"]));

/** Pointer coordinates are fractions (0..1) of the frame, so clients never need CSS sizes. */
export const ServerBrowserInputEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mouse"),
    action: z.enum(["move", "down", "up"]),
    x: z.number(),
    y: z.number(),
    button: z.enum(["none", "left", "right", "middle"]),
    clickCount: z.number().int().min(0).max(3),
    modifiers: ModifiersSchema.optional(),
  }),
  z.object({
    kind: z.literal("wheel"),
    x: z.number(),
    y: z.number(),
    deltaX: z.number(),
    deltaY: z.number(),
  }),
  z.object({
    kind: z.literal("key"),
    action: z.enum(["down", "up"]),
    key: z.string(),
    code: z.string(),
    keyCode: z.number().int(),
    text: z.string().optional(),
    modifiers: ModifiersSchema.optional(),
  }),
  z.object({
    kind: z.literal("text"),
    text: z.string(),
  }),
]);
export type ServerBrowserInputEvent = z.infer<typeof ServerBrowserInputEventSchema>;

export const ServerBrowserInputRequestSchema = z.object({
  type: z.literal("browser.server.input.request"),
  requestId: z.string(),
  browserId: z.string(),
  events: z.array(ServerBrowserInputEventSchema).max(64),
});
export const ServerBrowserInputResponseSchema = z.object({
  type: z.literal("browser.server.input.response"),
  payload: z.object({ requestId: z.string(), error: ErrorField }),
});

/**
 * The element a user picked in annotate mode, field for field the selector script's
 * selection (packages/server/src/server/browser-preview/inject/selector-script.ts), which is
 * the app's BrowserElementSelection.
 */
export const ServerBrowserElementSelectionSchema = z.object({
  tag: z.string(),
  text: z.string(),
  selector: z.string(),
  url: z.string(),
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
export type ServerBrowserElementSelection = z.infer<typeof ServerBrowserElementSelectionSchema>;

// Annotate element. Gated on server_info.features.serverBrowserAnnotate.
// start arms the picker in the page and answers when the user picks or cancels, so it stays
// pending while the user points. Pointer moves and the click travel as ordinary input requests.
export const ServerBrowserTabAnnotateStartRequestSchema = z.object({
  type: z.literal("browser.server.tab.annotate.start.request"),
  requestId: z.string(),
  browserId: z.string(),
});
export const ServerBrowserTabAnnotateStartResponseSchema = z.object({
  type: z.literal("browser.server.tab.annotate.start.response"),
  payload: z.object({
    requestId: z.string(),
    outcome: z.enum(["selected", "cancelled"]).optional(),
    selection: ServerBrowserElementSelectionSchema.optional(),
    /** The element's visible part, cropped by the daemon. Absent when it is off screen. */
    screenshot: z
      .object({
        /** Base64 PNG. */
        data: z.string(),
        mimeType: z.literal("image/png"),
      })
      .optional(),
    error: ErrorField,
  }),
});

export const ServerBrowserTabAnnotateCancelRequestSchema = z.object({
  type: z.literal("browser.server.tab.annotate.cancel.request"),
  requestId: z.string(),
  browserId: z.string(),
});
export const ServerBrowserTabAnnotateCancelResponseSchema = z.object({
  type: z.literal("browser.server.tab.annotate.cancel.response"),
  payload: z.object({ requestId: z.string(), error: ErrorField }),
});

/** Answers the tab's open dialog. Needs features.serverBrowserViewerControls. */
export const ServerBrowserTabDialogAnswerRequestSchema = z.object({
  type: z.literal("browser.server.tab.dialog.answer.request"),
  requestId: z.string(),
  browserId: z.string(),
  dialogId: z.string(),
  accept: z.boolean(),
  promptText: z.string().optional(),
});
export const ServerBrowserTabDialogAnswerResponseSchema = z.object({
  type: z.literal("browser.server.tab.dialog.answer.response"),
  payload: z.object({ requestId: z.string(), error: ErrorField }),
});

/** Answers the tab's file chooser with the files' bytes; no files cancels. Needs features.serverBrowserViewerControls. */
export const ServerBrowserTabFileChooserAnswerRequestSchema = z.object({
  type: z.literal("browser.server.tab.file_chooser.answer.request"),
  requestId: z.string(),
  browserId: z.string(),
  chooserId: z.string(),
  files: z.array(z.object({ name: z.string(), dataBase64: z.string() })).optional(),
});
export const ServerBrowserTabFileChooserAnswerResponseSchema = z.object({
  type: z.literal("browser.server.tab.file_chooser.answer.response"),
  payload: z.object({ requestId: z.string(), error: ErrorField }),
});

/** One console line of a tab; `seq` orders them across reads. Needs features.serverBrowserViewerControls. */
export const ServerBrowserConsoleEntrySchema = z.object({
  seq: z.number(),
  level: z.string(),
  message: z.string(),
  source: z.string().optional(),
  line: z.number().optional(),
  timestamp: z.number(),
});
export type ServerBrowserConsoleEntry = z.infer<typeof ServerBrowserConsoleEntrySchema>;

/** The tab's console since `after` (a seq), oldest first; the tab keeps its last 200 lines. */
export const ServerBrowserTabLogsRequestSchema = z.object({
  type: z.literal("browser.server.tab.logs.request"),
  requestId: z.string(),
  browserId: z.string(),
  after: z.number().optional(),
});
export const ServerBrowserTabLogsResponseSchema = z.object({
  type: z.literal("browser.server.tab.logs.response"),
  payload: z.object({
    requestId: z.string(),
    entries: z.array(ServerBrowserConsoleEntrySchema).optional(),
    error: ErrorField,
  }),
});

export const SERVER_BROWSER_INBOUND_SCHEMAS = [
  ServerBrowserTabsSubscribeRequestSchema,
  ServerBrowserTabOpenRequestSchema,
  ServerBrowserTabCloseRequestSchema,
  ServerBrowserTabNavigateRequestSchema,
  ServerBrowserTabSetViewportRequestSchema,
  ServerBrowserWorkspaceClearDataRequestSchema,
  ServerBrowserScreencastStartRequestSchema,
  ServerBrowserInputRequestSchema,
  ServerBrowserTabAnnotateStartRequestSchema,
  ServerBrowserTabAnnotateCancelRequestSchema,
  ServerBrowserTabLogsRequestSchema,
  ServerBrowserTabDialogAnswerRequestSchema,
  ServerBrowserTabFileChooserAnswerRequestSchema,
] as const;

export const SERVER_BROWSER_OUTBOUND_SCHEMAS = [
  ServerBrowserTabsSubscribeResponseSchema,
  ServerBrowserTabsUpdateSchema,
  ServerBrowserTabOpenResponseSchema,
  ServerBrowserTabCloseResponseSchema,
  ServerBrowserTabNavigateResponseSchema,
  ServerBrowserTabSetViewportResponseSchema,
  ServerBrowserWorkspaceClearDataResponseSchema,
  ServerBrowserScreencastStartResponseSchema,
  ServerBrowserInputResponseSchema,
  ServerBrowserTabAnnotateStartResponseSchema,
  ServerBrowserTabAnnotateCancelResponseSchema,
  ServerBrowserTabLogsResponseSchema,
  ServerBrowserTabDialogAnswerResponseSchema,
  ServerBrowserTabFileChooserAnswerResponseSchema,
] as const;
