import { AppRegistry, PermissionsAndroid } from "react-native";
import { Buffer } from "buffer";
import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";
import { i18n } from "@/i18n/i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import {
  MobilePortForwards,
  type ForwardConnectionCloseEvent,
  type ForwardConnectionDataEvent,
  type ForwardConnectionOpenEvent,
  type NativePortForwards,
} from "./mobile-port-forwards";
import { isHostOnThisDevice } from "./host-on-this-device";
import type { PortForwardController } from "./types";

/** The port-forward half of the PaseoBrowserProxy module (PortForwardListeners.kt). */
interface NativeModule extends NativePortForwards {
  showPortForwardService(title: string, text: string, stopLabel: string): Promise<void>;
  hidePortForwardService(): void;
  addListener(eventName: string, listener: (event: never) => void): EventSubscription;
}

/** Must match KEEP_ALIVE_TASK in PaseoBrowserProxyModule.kt. */
const KEEP_ALIVE_TASK = "PaseoPortForwardKeepAlive";

let controller: MobilePortForwards | null | undefined;

function createController(): MobilePortForwards | null {
  const native = requireOptionalNativeModule<NativeModule>("PaseoBrowserProxy");
  // An app binary older than this JS (an OTA update) has the module without the forwards.
  if (!native || typeof native.startPortForward !== "function") return null;
  const forwards = new MobilePortForwards({
    native,
    openTunnel: async ({ serverId, port }) => {
      const client = getHostRuntimeStore().getSnapshot(serverId)?.client ?? null;
      if (!client?.isConnected) throw new Error("Workspace host is not connected.");
      if (client.getLastServerInfoMessage()?.features?.tcpTunnel !== true) {
        throw new Error("Update the host to use Browser.");
      }
      return client.openTcpTunnel(port, { host: "ipv4" });
    },
    isLocalHost: (serverId) =>
      isHostOnThisDevice(getHostRuntimeStore().getSnapshot(serverId)?.activeConnection ?? null),
    service: {
      show: async () => {
        // Android 13+: without it the notification is hidden; the forwards still run.
        await PermissionsAndroid.request("android.permission.POST_NOTIFICATIONS").catch(() => null);
        await native.showPortForwardService(
          i18n.t("workspace.browser.portForward.notificationTitle"),
          i18n.t("workspace.browser.portForward.notificationText"),
          i18n.t("workspace.browser.portForward.notificationStop"),
        );
      },
      hide: () => native.hidePortForwardService(),
    },
    encodeBase64: (data) => Buffer.from(data).toString("base64"),
    decodeBase64: (base64) => new Uint8Array(Buffer.from(base64, "base64")),
  });
  native.addListener("onForwardConnectionOpen", (event: ForwardConnectionOpenEvent) =>
    forwards.handleConnectionOpen(event),
  );
  native.addListener("onForwardConnectionData", (event: ForwardConnectionDataEvent) =>
    forwards.handleConnectionData(event),
  );
  native.addListener("onForwardConnectionClose", (event: ForwardConnectionCloseEvent) =>
    forwards.handleConnectionClose(event),
  );
  native.addListener("onPortForwardStopRequested", () => forwards.handleStopRequested());
  // The task keeps JS timers running while Paseo is behind the browser; it ends with the forwards.
  AppRegistry.registerHeadlessTask(KEEP_ALIVE_TASK, () => () => forwards.whenIdle());
  return forwards;
}

/** Android: listeners on the phone's 127.0.0.1, held open by a foreground service. */
export function getPortForwardController(): PortForwardController | null {
  if (controller === undefined) controller = createController();
  return controller;
}
