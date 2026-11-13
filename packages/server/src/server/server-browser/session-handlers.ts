import type { Logger } from "pino";
import {
  encodeServerBrowserFrame,
  encodeServerBrowserVideoChunk,
  ServerBrowserOpcode,
  type ServerBrowserBinaryFrame,
} from "@getpaseo/protocol/binary-frames/server-browser";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { SessionDelivery } from "../session/owned-subscriptions/index.js";
import { cancelPick, pickElement } from "./element-picker.js";
import { SCREENCAST_MAX_WINDOW } from "./screencast-hub.js";
import { assertNavigableUrl, type ServerBrowserHost } from "./server-browser-host.js";

export const SERVER_BROWSER_REQUEST_TYPES = [
  "browser.server.tabs.subscribe.request",
  "browser.server.tab.open.request",
  "browser.server.tab.close.request",
  "browser.server.tab.navigate.request",
  "browser.server.tab.set_viewport.request",
  "browser.server.workspace.clear_data.request",
  "browser.server.screencast.start.request",
  "browser.server.input.request",
  "browser.server.tab.annotate.start.request",
  "browser.server.tab.annotate.cancel.request",
  "browser.server.tab.logs.request",
  "browser.server.tab.dialog.answer.request",
  "browser.server.tab.file_chooser.answer.request",
  "browser.server.tab.loopback_ports.request",
  "browser.server.tab.selection.request",
  "browser.server.tab.pin.request",
] as const;

type ServerBrowserRequest = Extract<
  SessionInboundMessage,
  { type: (typeof SERVER_BROWSER_REQUEST_TYPES)[number] }
>;

export function isServerBrowserRequest(msg: SessionInboundMessage): msg is ServerBrowserRequest {
  return (SERVER_BROWSER_REQUEST_TYPES as readonly string[]).includes(msg.type);
}

const SCREENCAST_FAMILY = "server-browser-screencast";
// The window bounds frames in flight end to end; this only stops piling onto a stalled socket.
const MAX_PENDING_SENDS = SCREENCAST_MAX_WINDOW;
const VIDEO_MAX_PENDING_SENDS = 32;

interface ScreencastStream {
  subscriptionId: string;
  browserId: string;
  viewerId: string;
  /** Which hub the viewer's acks go to; a video viewer whose capture failed moves to jpeg. */
  kind: "jpeg" | "video";
}

/** One client session's view of the server browser: RPCs, tab pushes, screencast streams. */
export class ServerBrowserSessionHandlers {
  private readonly streams = new Map<number, ScreencastStream>();
  private nextStreamId = 1;

  public constructor(
    private readonly params: {
      host: ServerBrowserHost;
      delivery: SessionDelivery;
      emit: (message: SessionOutboundMessage) => void;
      logger: Logger;
      sessionId: string;
    },
  ) {}

  public handle(msg: ServerBrowserRequest): Promise<void> {
    switch (msg.type) {
      case "browser.server.tabs.subscribe.request":
        return this.subscribeTabs(msg);
      case "browser.server.screencast.start.request":
        return this.startScreencast(msg);
      case "browser.server.tab.annotate.start.request":
        return this.annotate(msg);
      case "browser.server.tab.logs.request":
        return this.logs(msg);
      case "browser.server.tab.loopback_ports.request":
        return this.loopbackPorts(msg);
      case "browser.server.tab.selection.request":
        return this.selection(msg);
      default:
        return this.handleCommand(msg);
    }
  }

  public handleBinary(frame: ServerBrowserBinaryFrame, source: object): void {
    if (
      frame.opcode !== ServerBrowserOpcode.FrameAck &&
      frame.opcode !== ServerBrowserOpcode.VideoKeyframeRequest
    ) {
      return;
    }
    const stream = this.streams.get(frame.streamId);
    if (!stream) return;
    // Only the socket that owns the stream may spend its credit.
    if (
      !this.params.delivery
        .subscriptionIds(source, SCREENCAST_FAMILY)
        .includes(stream.subscriptionId)
    ) {
      return;
    }
    const tab = this.params.host.getTab(stream.browserId);
    if (frame.opcode === ServerBrowserOpcode.VideoKeyframeRequest) {
      if (stream.kind === "video") tab?.video?.viewerKeyframe(stream.viewerId);
      return;
    }
    if (stream.kind === "video") tab?.video?.hub.ack(stream.viewerId, frame.seq);
    else tab?.screencast.ack(stream.viewerId, frame.seq);
  }

  private async subscribeTabs(
    msg: Extract<ServerBrowserRequest, { type: "browser.server.tabs.subscribe.request" }>,
  ): Promise<void> {
    const { host, delivery, emit } = this.params;
    await host.whenRestored();
    let unsubscribe: (() => void) | undefined;
    const owner = delivery.begin("server-browser-tabs", undefined, () => unsubscribe?.());
    unsubscribe = host.subscribe((tabs, status) => {
      owner.emit({ type: "browser.server.tabs.update", payload: { tabs, status } });
    });
    emit({
      type: "browser.server.tabs.subscribe.response",
      payload: {
        requestId: msg.requestId,
        subscriptionId: owner.responseId,
        tabs: host.listTabs(),
        status: host.status(),
      },
    });
  }

  private async startScreencast(
    msg: Extract<ServerBrowserRequest, { type: "browser.server.screencast.start.request" }>,
  ): Promise<void> {
    const { host, delivery, emit } = this.params;
    const tab = host.getTab(msg.browserId);
    if (!tab) {
      emit({
        type: "browser.server.screencast.start.response",
        payload: { requestId: msg.requestId, error: `No server browser tab ${msg.browserId}` },
      });
      return;
    }
    const streamId = this.nextStreamId++;
    const viewerId = `${this.params.sessionId}:${streamId}`;
    const codec = msg.video ? ((await tab.video?.negotiate(msg.video.codecs)) ?? null) : null;
    const owner = delivery.begin(SCREENCAST_FAMILY, undefined, () => {
      this.streams.delete(streamId);
      const current = host.getTab(msg.browserId);
      current?.screencast.removeViewer(viewerId);
      current?.video?.removeViewer(viewerId);
    });
    const stream: ScreencastStream = {
      subscriptionId: owner.id,
      browserId: msg.browserId,
      viewerId,
      kind: codec ? "video" : "jpeg",
    };
    this.streams.set(streamId, stream);
    let pendingSends = 0;
    const emitCounted = (bytes: Uint8Array) => {
      pendingSends += 1;
      void owner
        .emitBinaryAndWait(bytes)
        .catch(() => {})
        .finally(() => {
          pendingSends -= 1;
        });
    };
    const size = { maxWidth: msg.maxWidth, maxHeight: msg.maxHeight };
    const watchJpeg = () =>
      tab.screencast.addViewer(
        viewerId,
        {
          send: (frame, seq) =>
            emitCounted(
              encodeServerBrowserFrame({
                streamId,
                seq,
                width: frame.width,
                height: frame.height,
                jpeg: frame.jpeg,
              }),
            ),
          isCongested: () => pendingSends >= MAX_PENDING_SENDS,
        },
        size,
      );
    emit({
      type: "browser.server.screencast.start.response",
      payload: {
        requestId: msg.requestId,
        subscriptionId: owner.responseId,
        streamId,
        ...(codec ? { video: { codec } } : {}),
      },
    });
    if (!codec || !tab.video) {
      watchJpeg();
      return;
    }
    // A suspended tab's last frame shows until its reloaded page streams; its ack is ignored.
    const still = tab.currentStillFrame;
    if (still) {
      emitCounted(
        encodeServerBrowserFrame({
          streamId,
          seq: 0,
          width: still.width,
          height: still.height,
          jpeg: still.jpeg,
        }),
      );
    }
    tab.video.addViewer(
      viewerId,
      {
        send: (chunk, seq) =>
          emitCounted(
            encodeServerBrowserVideoChunk({
              streamId,
              seq,
              width: chunk.width,
              height: chunk.height,
              key: chunk.key,
              data: chunk.data,
            }),
          ),
        // Chunks are small and the hub's window bounds them; only a stalled socket counts.
        isCongested: () => pendingSends >= VIDEO_MAX_PENDING_SENDS,
        fallback: () => {
          if (!this.streams.has(streamId)) return;
          stream.kind = "jpeg";
          watchJpeg();
        },
      },
      { ...size, codec },
    );
  }

  private async logs(
    msg: Extract<ServerBrowserRequest, { type: "browser.server.tab.logs.request" }>,
  ): Promise<void> {
    const tab = this.params.host.getTab(msg.browserId);
    this.params.emit({
      type: "browser.server.tab.logs.response",
      payload: tab
        ? { requestId: msg.requestId, entries: tab.consoleSince(msg.after) }
        : { requestId: msg.requestId, error: `No server browser tab ${msg.browserId}` },
    });
  }

  private async loopbackPorts(
    msg: Extract<ServerBrowserRequest, { type: "browser.server.tab.loopback_ports.request" }>,
  ): Promise<void> {
    const tab = this.params.host.getTab(msg.browserId);
    this.params.emit({
      type: "browser.server.tab.loopback_ports.response",
      payload: tab
        ? { requestId: msg.requestId, ports: tab.observedLoopbackPorts() }
        : { requestId: msg.requestId, error: `No server browser tab ${msg.browserId}` },
    });
  }

  private async selection(
    msg: Extract<ServerBrowserRequest, { type: "browser.server.tab.selection.request" }>,
  ): Promise<void> {
    const tab = this.params.host.getTab(msg.browserId);
    let payload: { requestId: string; text?: string; error?: string };
    try {
      if (!tab) throw new Error(`No server browser tab ${msg.browserId}`);
      payload = { requestId: msg.requestId, text: await tab.readSelection() };
    } catch (caught) {
      payload = {
        requestId: msg.requestId,
        error: caught instanceof Error ? caught.message : String(caught),
      };
    }
    this.params.emit({ type: "browser.server.tab.selection.response", payload });
  }

  private async annotate(
    msg: Extract<ServerBrowserRequest, { type: "browser.server.tab.annotate.start.request" }>,
  ): Promise<void> {
    const { host, delivery, emit } = this.params;
    // Aborts when the requesting socket goes away, so a closed client never leaves the page armed.
    const signal = delivery.requestSignal;
    const tab = host.getTab(msg.browserId);
    if (!tab) {
      emit({
        type: "browser.server.tab.annotate.start.response",
        payload: { requestId: msg.requestId, error: `No server browser tab ${msg.browserId}` },
      });
      return;
    }
    tab.touch();
    try {
      const result = await pickElement(tab.contents, signal);
      emit({
        type: "browser.server.tab.annotate.start.response",
        payload: { requestId: msg.requestId, ...result },
      });
    } catch (caught) {
      this.params.logger.debug({ err: caught }, "Server browser annotate failed");
      emit({
        type: "browser.server.tab.annotate.start.response",
        payload: {
          requestId: msg.requestId,
          error: caught instanceof Error ? caught.message : String(caught),
        },
      });
    }
  }

  private async handleCommand(
    msg: Exclude<
      ServerBrowserRequest,
      {
        type:
          | "browser.server.tabs.subscribe.request"
          | "browser.server.screencast.start.request"
          | "browser.server.tab.annotate.start.request"
          | "browser.server.tab.logs.request"
          | "browser.server.tab.loopback_ports.request"
          | "browser.server.tab.selection.request";
      }
    >,
  ): Promise<void> {
    let error: string | undefined;
    let browserId: string | undefined;
    try {
      browserId = await this.runCommand(msg);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      this.params.logger.debug({ err: caught, type: msg.type }, "Server browser request failed");
    }
    const payload = { requestId: msg.requestId, ...(error ? { error } : {}) };
    switch (msg.type) {
      case "browser.server.tab.open.request":
        this.params.emit({
          type: "browser.server.tab.open.response",
          payload: { ...payload, ...(browserId ? { browserId } : {}) },
        });
        return;
      case "browser.server.tab.close.request":
        this.params.emit({ type: "browser.server.tab.close.response", payload });
        return;
      case "browser.server.tab.navigate.request":
        this.params.emit({ type: "browser.server.tab.navigate.response", payload });
        return;
      case "browser.server.tab.set_viewport.request":
        this.params.emit({ type: "browser.server.tab.set_viewport.response", payload });
        return;
      case "browser.server.workspace.clear_data.request":
        this.params.emit({ type: "browser.server.workspace.clear_data.response", payload });
        return;
      case "browser.server.input.request":
        this.params.emit({ type: "browser.server.input.response", payload });
        return;
      case "browser.server.tab.annotate.cancel.request":
        this.params.emit({ type: "browser.server.tab.annotate.cancel.response", payload });
        return;
      case "browser.server.tab.dialog.answer.request":
        this.params.emit({ type: "browser.server.tab.dialog.answer.response", payload });
        return;
      case "browser.server.tab.file_chooser.answer.request":
        this.params.emit({ type: "browser.server.tab.file_chooser.answer.response", payload });
        return;
      case "browser.server.tab.pin.request":
        this.params.emit({ type: "browser.server.tab.pin.response", payload });
        return;
    }
  }

  private async runCommand(
    msg: Exclude<
      ServerBrowserRequest,
      {
        type:
          | "browser.server.tabs.subscribe.request"
          | "browser.server.screencast.start.request"
          | "browser.server.tab.annotate.start.request"
          | "browser.server.tab.logs.request"
          | "browser.server.tab.loopback_ports.request"
          | "browser.server.tab.selection.request";
      }
    >,
  ): Promise<string | undefined> {
    const { host } = this.params;
    if (msg.type === "browser.server.tab.open.request") {
      const tab = await host.openTab({
        workspaceId: msg.workspaceId,
        url: msg.url,
        openedBy: "user",
      });
      return tab.browserId;
    }
    if (msg.type === "browser.server.workspace.clear_data.request") {
      await host.clearWorkspaceData(msg.workspaceId);
      return undefined;
    }
    if (msg.type === "browser.server.tab.close.request") {
      // Older apps know nothing of pins, so the host refuses for them too.
      if (host.getTab(msg.browserId)?.pinned) {
        throw new Error("This tab is pinned. Unpin it before closing it.");
      }
      await host.closeTab(msg.browserId);
      return undefined;
    }
    if (msg.type === "browser.server.tab.pin.request") {
      await host.setTabPinned(msg.browserId, msg.pinned);
      return undefined;
    }
    if (msg.type === "browser.server.tab.file_chooser.answer.request") {
      await host.answerFileChooser(msg.browserId, msg.chooserId, msg.files ?? []);
      return undefined;
    }
    const tab = host.getTab(msg.browserId);
    if (!tab) throw new Error(`No server browser tab ${msg.browserId}`);
    switch (msg.type) {
      case "browser.server.tab.navigate.request":
        if (msg.action === "back") await tab.goHistory(-1);
        else if (msg.action === "forward") await tab.goHistory(1);
        else if (msg.action === "reload") await tab.reload();
        else if (msg.action === "stop") await tab.stopLoading();
        else await navigateTo(tab, msg.url);
        return undefined;
      case "browser.server.tab.set_viewport.request":
        await tab.setViewport({ width: msg.width, height: msg.height, mobile: msg.mobile });
        return undefined;
      case "browser.server.input.request":
        await tab.dispatchInput(msg.events);
        return undefined;
      case "browser.server.tab.annotate.cancel.request":
        cancelPick(tab.contents);
        return undefined;
      case "browser.server.tab.dialog.answer.request":
        await tab.answerDialog({
          dialogId: msg.dialogId,
          accept: msg.accept,
          ...(msg.promptText !== undefined ? { promptText: msg.promptText } : {}),
        });
        return undefined;
    }
  }
}

async function navigateTo(
  tab: NonNullable<ReturnType<ServerBrowserHost["getTab"]>>,
  url: string | undefined,
): Promise<void> {
  if (!url) throw new Error("navigate with action url needs a url");
  assertNavigableUrl(url);
  await tab.navigate(url);
}
