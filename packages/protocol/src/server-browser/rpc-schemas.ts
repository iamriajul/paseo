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
});
export type ServerBrowserTab = z.infer<typeof ServerBrowserTabSchema>;

export const ServerBrowserStatusSchema = z.object({
  enabled: z.boolean(),
  /** Why the browser cannot run on this host (no Chromium found, launch failure). */
  unavailableReason: z.string().optional(),
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

export const ServerBrowserNavigateActionSchema = z.enum(["url", "back", "forward", "reload"]);
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
});
export const ServerBrowserScreencastStartResponseSchema = z.object({
  type: z.literal("browser.server.screencast.start.response"),
  payload: z.object({
    requestId: z.string(),
    /** Release with subscription.release.request to stop the stream. */
    subscriptionId: z.string().optional(),
    /** Matches the streamId of binary Frame (0x40) and FrameAck (0x41) frames. */
    streamId: z.number().int().optional(),
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

export const SERVER_BROWSER_INBOUND_SCHEMAS = [
  ServerBrowserTabsSubscribeRequestSchema,
  ServerBrowserTabOpenRequestSchema,
  ServerBrowserTabCloseRequestSchema,
  ServerBrowserTabNavigateRequestSchema,
  ServerBrowserTabSetViewportRequestSchema,
  ServerBrowserWorkspaceClearDataRequestSchema,
  ServerBrowserScreencastStartRequestSchema,
  ServerBrowserInputRequestSchema,
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
] as const;
