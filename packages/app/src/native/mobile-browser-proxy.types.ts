import type { EventSubscription } from "expo-modules-core";

export interface MobileBrowserProxySupport {
  proxyOverride: boolean;
  reverseBypass: boolean;
}

export interface MobileBrowserProxySession {
  sessionId: string;
  host: string;
  port: number;
  realm: string;
  username: string;
  password: string;
}

export interface MobileBrowserProxyConnectionOpenEvent {
  sessionId: string;
  connectionId: string;
  host: "ipv4" | "ipv6";
  port: number;
  initialDataBase64: string;
}

export interface MobileBrowserProxyConnectionDataEvent {
  sessionId: string;
  connectionId: string;
  binaryBase64: string;
}

export interface MobileBrowserProxyConnectionCloseEvent {
  sessionId: string;
  connectionId: string;
  reason?: string | null;
}

export interface MobileBrowserProxyConnectionErrorEvent {
  sessionId: string;
  connectionId?: string | null;
  message: string;
}

export interface MobileBrowserProxyApi {
  readonly isAvailable: boolean;
  getSupportStatus(): MobileBrowserProxySupport;
  startProxy(): Promise<MobileBrowserProxySession>;
  stopProxy(): Promise<void>;
  acceptConnection(connectionId: string): void;
  rejectConnection(connectionId: string, statusCode: number, message: string): void;
  writeConnection(connectionId: string, binaryBase64: string): void;
  closeConnection(connectionId: string, reason?: string): void;
  clearBrowserData(): Promise<void>;
  addConnectionOpenListener(
    listener: (event: MobileBrowserProxyConnectionOpenEvent) => void,
  ): EventSubscription;
  addConnectionDataListener(
    listener: (event: MobileBrowserProxyConnectionDataEvent) => void,
  ): EventSubscription;
  addConnectionCloseListener(
    listener: (event: MobileBrowserProxyConnectionCloseEvent) => void,
  ): EventSubscription;
  addConnectionErrorListener(
    listener: (event: MobileBrowserProxyConnectionErrorEvent) => void,
  ): EventSubscription;
}

export function createEmptyEventSubscription(): EventSubscription {
  return { remove: () => {} };
}
