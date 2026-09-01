import {
  createEmptyEventSubscription,
  type MobileBrowserProxyApi,
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

const unsupportedError = "Android Browser proxy is unavailable on this platform.";

export const mobileBrowserProxy: MobileBrowserProxyApi = {
  isAvailable: false,
  getSupportStatus: () => ({ proxyOverride: false, reverseBypass: false }),
  startProxy: () => Promise.reject(new Error(unsupportedError)),
  stopProxy: () => Promise.resolve(),
  acceptConnection: () => {},
  rejectConnection: () => {},
  writeConnection: () => {},
  closeConnection: () => {},
  clearBrowserData: () => Promise.reject(new Error(unsupportedError)),
  addConnectionOpenListener: createEmptyEventSubscription,
  addConnectionDataListener: createEmptyEventSubscription,
  addConnectionCloseListener: createEmptyEventSubscription,
  addConnectionErrorListener: createEmptyEventSubscription,
};
