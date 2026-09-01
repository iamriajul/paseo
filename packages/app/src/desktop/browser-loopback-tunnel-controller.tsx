import { useEffect } from "react";
import type { TcpTunnelStream } from "@getpaseo/client/internal/daemon-client";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { getDesktopHost, isElectronRuntime, type DesktopBrowserBridge } from "@/desktop/host";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

interface TunnelOpenPayload {
  tunnelId: string;
  browserId: string;
  serverId: string;
  workspaceId: string;
  port: number;
  host: "ipv4" | "ipv6";
}

interface TunnelDataPayload {
  tunnelId: string;
  binaryBase64: string;
}

interface TunnelClosePayload {
  tunnelId: string;
  reason?: string | null;
}

interface ActiveTunnel {
  stream: TcpTunnelStream;
  disposeData: () => void;
  disposeClose: () => void;
}

function encodeBinaryToBase64(data: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < data.length; index += 1) {
    binary += String.fromCharCode(data[index]);
  }
  return globalThis.btoa(binary);
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function readOpenPayload(payload: unknown): TunnelOpenPayload | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const port = typeof record.port === "number" ? record.port : NaN;
  const host = record.host === "ipv6" ? "ipv6" : "ipv4";
  if (
    typeof record.tunnelId !== "string" ||
    typeof record.browserId !== "string" ||
    typeof record.serverId !== "string" ||
    typeof record.workspaceId !== "string" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return null;
  }
  return {
    tunnelId: record.tunnelId,
    browserId: record.browserId,
    serverId: record.serverId,
    workspaceId: record.workspaceId,
    port,
    host,
  };
}

function readDataPayload(payload: unknown): TunnelDataPayload | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.tunnelId !== "string" || typeof record.binaryBase64 !== "string") {
    return null;
  }
  return { tunnelId: record.tunnelId, binaryBase64: record.binaryBase64 };
}

function readClosePayload(payload: unknown): TunnelClosePayload | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.tunnelId !== "string") {
    return null;
  }
  return {
    tunnelId: record.tunnelId,
    reason: typeof record.reason === "string" ? record.reason : null,
  };
}

function disposeTunnel(active: ActiveTunnel): void {
  active.disposeData();
  active.disposeClose();
  active.stream.close("Browser proxy tunnel closed.");
}

function sendTunnelOpenFailure(
  browserHost: DesktopBrowserBridge,
  tunnelId: string,
  reason: string,
): void {
  browserHost.sendLoopbackTunnelOpenResult?.({
    tunnelId,
    ok: false,
    reason,
  });
}

function attachActiveTunnel(input: {
  activeTunnels: Map<string, ActiveTunnel>;
  browserHost: DesktopBrowserBridge;
  request: TunnelOpenPayload;
  stream: TcpTunnelStream;
}): void {
  const { activeTunnels, browserHost, request, stream } = input;
  const disposeData = stream.onData((data) => {
    browserHost.sendLoopbackTunnelData?.({
      tunnelId: request.tunnelId,
      binaryBase64: encodeBinaryToBase64(data),
    });
  });
  const disposeClose = stream.onClose((reason) => {
    activeTunnels.delete(request.tunnelId);
    browserHost.sendLoopbackTunnelClose?.({ tunnelId: request.tunnelId, reason });
  });
  activeTunnels.set(request.tunnelId, { stream, disposeData, disposeClose });
}

async function openWorkspaceTunnel(input: {
  activeTunnels: Map<string, ActiveTunnel>;
  browserHost: DesktopBrowserBridge;
  isCanceled: () => boolean;
  isDisposed: () => boolean;
  onSettled: () => void;
  request: TunnelOpenPayload;
}): Promise<void> {
  const { activeTunnels, browserHost, isCanceled, isDisposed, onSettled, request } = input;
  const client = getHostRuntimeStore().getSnapshot(request.serverId)?.client ?? null;
  const hasTunnelFeature = client?.getLastServerInfoMessage()?.features?.tcpTunnel === true;
  try {
    if (isDisposed() || isCanceled()) {
      return;
    }
    if (!client || !client.isConnected) {
      sendTunnelOpenFailure(browserHost, request.tunnelId, "Workspace host is not connected.");
      return;
    }
    if (!hasTunnelFeature) {
      sendTunnelOpenFailure(
        browserHost,
        request.tunnelId,
        "Update the host to use workspace localhost in Browser.",
      );
      return;
    }

    const stream = await client.openTcpTunnel(request.port, { host: request.host });
    if (isDisposed() || isCanceled()) {
      stream.close("Browser proxy tunnel open was canceled.");
      return;
    }
    attachActiveTunnel({ activeTunnels, browserHost, request, stream });
    browserHost.sendLoopbackTunnelOpenResult?.({ tunnelId: request.tunnelId, ok: true });
  } catch (error) {
    if (isDisposed() || isCanceled()) {
      return;
    }
    sendTunnelOpenFailure(
      browserHost,
      request.tunnelId,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    onSettled();
  }
}

export function BrowserLoopbackTunnelController() {
  useEffect(() => {
    if (!isElectronRuntime()) {
      return;
    }

    let disposed = false;
    const activeTunnels = new Map<string, ActiveTunnel>();
    const pendingOpenTunnels = new Set<string>();
    const canceledOpenTunnels = new Set<string>();
    const browserHost = getDesktopHost()?.browser;

    const closeActiveTunnel = (tunnelId: string, reason: string): void => {
      const active = activeTunnels.get(tunnelId);
      if (!active) {
        return;
      }
      activeTunnels.delete(tunnelId);
      active.disposeData();
      active.disposeClose();
      active.stream.close(reason);
    };

    const openListenerPromise = listenToDesktopEvent<unknown>(
      "browser-loopback-tunnel-open",
      (payload) => {
        const request = readOpenPayload(payload);
        if (!request || !browserHost?.sendLoopbackTunnelOpenResult) {
          return;
        }

        pendingOpenTunnels.add(request.tunnelId);
        canceledOpenTunnels.delete(request.tunnelId);
        void openWorkspaceTunnel({
          activeTunnels,
          browserHost,
          isCanceled: () => canceledOpenTunnels.has(request.tunnelId),
          isDisposed: () => disposed,
          onSettled: () => {
            pendingOpenTunnels.delete(request.tunnelId);
            canceledOpenTunnels.delete(request.tunnelId);
          },
          request,
        });
      },
    );

    const dataListenerPromise = listenToDesktopEvent<unknown>(
      "browser-loopback-tunnel-data",
      (payload) => {
        const data = readDataPayload(payload);
        if (!data) {
          return;
        }
        activeTunnels.get(data.tunnelId)?.stream.write(decodeBase64ToBytes(data.binaryBase64));
      },
    );

    const closeListenerPromise = listenToDesktopEvent<unknown>(
      "browser-loopback-tunnel-close",
      (payload) => {
        const close = readClosePayload(payload);
        if (!close) {
          return;
        }
        if (!activeTunnels.has(close.tunnelId) && pendingOpenTunnels.has(close.tunnelId)) {
          canceledOpenTunnels.add(close.tunnelId);
          return;
        }
        closeActiveTunnel(close.tunnelId, close.reason ?? "Browser proxy tunnel closed.");
      },
    );

    return () => {
      disposed = true;
      for (const active of activeTunnels.values()) {
        disposeTunnel(active);
      }
      activeTunnels.clear();
      pendingOpenTunnels.clear();
      canceledOpenTunnels.clear();
      void openListenerPromise.then((dispose) => dispose()).catch(() => undefined);
      void dataListenerPromise.then((dispose) => dispose()).catch(() => undefined);
      void closeListenerPromise.then((dispose) => dispose()).catch(() => undefined);
    };
  }, []);

  return null;
}
