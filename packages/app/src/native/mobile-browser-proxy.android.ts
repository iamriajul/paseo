import { requireOptionalNativeModule } from "expo-modules-core";
import type { EventSubscription } from "expo-modules-core";
import {
  createEmptyEventSubscription,
  type MobileBrowserProxyApi,
  type MobileBrowserProxyConnectionCloseEvent,
  type MobileBrowserProxyConnectionDataEvent,
  type MobileBrowserProxyConnectionErrorEvent,
  type MobileBrowserProxyConnectionOpenEvent,
  type MobileBrowserProxySession,
  type MobileBrowserProxySupport,
} from "./mobile-browser-proxy.types";

export type {
  MobileBrowserProxyApi,
  MobileBrowserProxyConnectionCloseEvent,
  MobileBrowserProxyConnectionDataEvent,
  MobileBrowserProxyConnectionErrorEvent,
  MobileBrowserProxyConnectionOpenEvent,
  MobileBrowserProxySession,
  MobileBrowserProxySupport,
} from "./mobile-browser-proxy.types";

type NativeEventName =
  | "onProxyConnectionOpen"
  | "onProxyConnectionData"
  | "onProxyConnectionClose"
  | "onProxyConnectionError";

interface PaseoBrowserProxyNativeModule {
  getSupportStatus(): MobileBrowserProxySupport;
  startProxy(): Promise<MobileBrowserProxySession>;
  stopProxy(): Promise<void>;
  acceptConnection(connectionId: string): void;
  rejectConnection(connectionId: string, statusCode: number, message: string): void;
  writeConnection(connectionId: string, binaryBase64: string): void;
  closeConnection(connectionId: string, reason?: string): void;
  clearBrowserData(): Promise<void>;
  addListener<T>(eventName: NativeEventName, listener: (event: T) => void): EventSubscription;
}

const nativeModule =
  requireOptionalNativeModule<PaseoBrowserProxyNativeModule>("PaseoBrowserProxy");

function missingModuleError(): Error {
  return new Error("Update the Android app to use the workspace Browser.");
}

function addListener<T>(eventName: NativeEventName, listener: (event: T) => void) {
  return nativeModule?.addListener(eventName, listener) ?? createEmptyEventSubscription();
}

export const mobileBrowserProxy: MobileBrowserProxyApi = {
  isAvailable: nativeModule !== null,
  getSupportStatus: () =>
    nativeModule?.getSupportStatus() ?? { proxyOverride: false, reverseBypass: false },
  startProxy: () => nativeModule?.startProxy() ?? Promise.reject(missingModuleError()),
  stopProxy: () => nativeModule?.stopProxy() ?? Promise.resolve(),
  acceptConnection: (connectionId) => nativeModule?.acceptConnection(connectionId),
  rejectConnection: (connectionId, statusCode, message) =>
    nativeModule?.rejectConnection(connectionId, statusCode, message),
  writeConnection: (connectionId, binaryBase64) =>
    nativeModule?.writeConnection(connectionId, binaryBase64),
  closeConnection: (connectionId, reason) => nativeModule?.closeConnection(connectionId, reason),
  clearBrowserData: () => nativeModule?.clearBrowserData() ?? Promise.reject(missingModuleError()),
  addConnectionOpenListener: (listener) =>
    addListener<MobileBrowserProxyConnectionOpenEvent>("onProxyConnectionOpen", listener),
  addConnectionDataListener: (listener) =>
    addListener<MobileBrowserProxyConnectionDataEvent>("onProxyConnectionData", listener),
  addConnectionCloseListener: (listener) =>
    addListener<MobileBrowserProxyConnectionCloseEvent>("onProxyConnectionClose", listener),
  addConnectionErrorListener: (listener) =>
    addListener<MobileBrowserProxyConnectionErrorEvent>("onProxyConnectionError", listener),
};
