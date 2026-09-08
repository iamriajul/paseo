import { PASEO_BROWSER_PROFILE_PARTITION } from "./browser-profile.js";

export interface ElectronCookieLike {
  name: string;
  value: string;
  domain?: string;
  hostOnly?: boolean;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  session?: boolean;
  expirationDate?: number;
  sameSite?: string;
}

export interface ElectronCookiesApi {
  get(filter?: unknown): Promise<ElectronCookieLike[]>;
  set(details: { url: string; [key: string]: unknown }): Promise<void>;
  remove(url: string, name: string): Promise<void>;
  on(
    event: string,
    listener: (event: unknown, cookie: ElectronCookieLike, cause: string, removed: boolean) => void,
  ): unknown;
  removeListener?(
    event: string,
    listener: (event: unknown, cookie: ElectronCookieLike, cause: string, removed: boolean) => void,
  ): unknown;
}

export interface ElectronSessionWithCookies {
  cookies: ElectronCookiesApi;
}

export interface ElectronSessionsWithCookies {
  fromPartition(partition: string): ElectronSessionWithCookies;
}

const IPV4_LOOPBACK_PATTERN =
  /^127\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export function isLocalhostCookieDomain(domain: string | null | undefined): boolean {
  if (!domain) {
    return false;
  }
  const normalized = domain
    .trim()
    .toLowerCase()
    .replace(/^\./, "")
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "0.0.0.0" ||
    IPV4_LOOPBACK_PATTERN.test(normalized) ||
    normalized === "::1" ||
    normalized === "::"
  );
}

export function buildCookieUrl(cookie: {
  domain?: string;
  path?: string;
  secure?: boolean;
}): string {
  const scheme = cookie.secure ? "https" : "http";
  const rawDomain = (cookie.domain ?? "").trim().replace(/^\./, "");
  const isIpv6 = rawDomain.includes(":") && !rawDomain.startsWith("[");
  const host = isIpv6 ? `[${rawDomain.replace(/^\[|\]$/g, "")}]` : rawDomain || "localhost";
  const rawPath = (cookie.path ?? "/").trim();
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  return `${scheme}://${host}${path}`;
}

export function cookieToSetDetails(cookie: ElectronCookieLike): {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
} {
  const url = buildCookieUrl(cookie);
  const details: {
    url: string;
    name: string;
    value: string;
    domain?: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    expirationDate?: number;
    sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
  } = {
    url,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path && cookie.path.startsWith("/") ? cookie.path : "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
  };

  if (cookie.domain) {
    const trimmedDomain = cookie.domain.trim();
    if (trimmedDomain.startsWith(".") || cookie.hostOnly !== true) {
      details.domain = trimmedDomain.startsWith(".") ? trimmedDomain : `.${trimmedDomain}`;
    }
  }

  if (
    !cookie.session &&
    typeof cookie.expirationDate === "number" &&
    Number.isFinite(cookie.expirationDate)
  ) {
    details.expirationDate = cookie.expirationDate;
  }

  if (
    cookie.sameSite === "unspecified" ||
    cookie.sameSite === "no_restriction" ||
    cookie.sameSite === "lax" ||
    cookie.sameSite === "strict"
  ) {
    details.sameSite = cookie.sameSite;
  }

  return details;
}

function cookieKey(cookie: ElectronCookieLike): string {
  const domain = (cookie.domain ?? "").trim().toLowerCase();
  const name = cookie.name;
  const path = (cookie.path ?? "/").trim();
  const secure = cookie.secure ? "1" : "0";
  return `${domain}|${name}|${path}|${secure}`;
}

export class PaseoBrowserCookieSync {
  private readonly sessions: ElectronSessionsWithCookies;
  private readonly sharedPartition: string;
  private readonly activeWorkspacePartitions = new Set<string>();
  private readonly watchedPartitions = new Set<string>();
  private readonly inFlightSync = new Map<string, { count: number; timestamp: number }>();

  public constructor(options: { sessions: ElectronSessionsWithCookies; sharedPartition?: string }) {
    this.sessions = options.sessions;
    this.sharedPartition = options.sharedPartition ?? PASEO_BROWSER_PROFILE_PARTITION;
    this.watchPartition(this.sharedPartition);
  }

  public getActiveWorkspacePartitions(): string[] {
    return Array.from(this.activeWorkspacePartitions);
  }

  public async registerWorkspacePartition(partition: string): Promise<void> {
    const normalized = partition.trim();
    if (!normalized || normalized === this.sharedPartition) {
      return;
    }
    const isNew = !this.activeWorkspacePartitions.has(normalized);
    this.activeWorkspacePartitions.add(normalized);
    this.watchPartition(normalized);

    if (isNew) {
      await this.syncInitialCookiesToWorkspace(normalized);
    }
  }

  public unregisterWorkspacePartition(partition: string): void {
    const normalized = partition.trim();
    this.activeWorkspacePartitions.delete(normalized);
    const prefix = `${normalized}:`;
    for (const key of Array.from(this.inFlightSync.keys())) {
      if (key.startsWith(prefix)) {
        this.inFlightSync.delete(key);
      }
    }
  }

  private watchPartition(partition: string): void {
    if (this.watchedPartitions.has(partition)) {
      return;
    }
    this.watchedPartitions.add(partition);
    const ses = this.sessions.fromPartition(partition);
    ses.cookies.on("changed", (_event, cookie, cause, removed) => {
      void this.onCookieChanged(partition, cookie, cause, removed);
    });
  }

  private async syncInitialCookiesToWorkspace(targetPartition: string): Promise<void> {
    const sharedSession = this.sessions.fromPartition(this.sharedPartition);
    const targetSession = this.sessions.fromPartition(targetPartition);

    let sharedCookies: ElectronCookieLike[] = [];
    try {
      sharedCookies = await sharedSession.cookies.get({});
    } catch {
      sharedCookies = [];
    }

    for (const cookie of sharedCookies) {
      if (isLocalhostCookieDomain(cookie.domain)) {
        continue;
      }
      const syncKey = `${targetPartition}:${cookieKey(cookie)}`;
      const record = this.inFlightSync.get(syncKey);
      this.inFlightSync.set(syncKey, { count: (record?.count ?? 0) + 1, timestamp: Date.now() });

      try {
        await targetSession.cookies.set(cookieToSetDetails(cookie));
      } catch {
        const current = this.inFlightSync.get(syncKey);
        if (current && current.count > 1) {
          current.count -= 1;
        } else {
          this.inFlightSync.delete(syncKey);
        }
      }
    }

    // If the target partition has non-localhost cookies that sharedSession is missing,
    // replicate them to sharedPartition and any other active workspace partitions.
    let targetCookies: ElectronCookieLike[] = [];
    try {
      targetCookies = await targetSession.cookies.get({});
    } catch {
      targetCookies = [];
    }

    for (const cookie of targetCookies) {
      if (!isLocalhostCookieDomain(cookie.domain)) {
        await this.replicateCookie(targetPartition, cookie, false);
      }
    }
  }

  private async onCookieChanged(
    sourcePartition: string,
    cookie: ElectronCookieLike,
    _cause: string,
    removed: boolean,
  ): Promise<void> {
    // Localhost cookies (direct or service proxy) are scoped strictly to the workspace session.
    if (isLocalhostCookieDomain(cookie.domain)) {
      return;
    }

    const key = `${sourcePartition}:${cookieKey(cookie)}`;
    const inFlight = this.inFlightSync.get(key);
    if (inFlight && Date.now() - inFlight.timestamp < 10_000 && inFlight.count > 0) {
      if (inFlight.count <= 1) {
        this.inFlightSync.delete(key);
      } else {
        inFlight.count -= 1;
      }
      return;
    }

    await this.replicateCookie(sourcePartition, cookie, removed);
  }

  private async replicateCookie(
    sourcePartition: string,
    cookie: ElectronCookieLike,
    removed: boolean,
  ): Promise<void> {
    const destinations = new Set<string>([this.sharedPartition, ...this.activeWorkspacePartitions]);
    destinations.delete(sourcePartition);

    if (destinations.size === 0) {
      return;
    }

    const key = cookieKey(cookie);
    const details = !removed ? cookieToSetDetails(cookie) : null;
    const url = removed ? buildCookieUrl(cookie) : null;

    await Promise.all(
      Array.from(destinations).map(async (targetPartition) => {
        const syncKey = `${targetPartition}:${key}`;
        const existing = this.inFlightSync.get(syncKey);
        this.inFlightSync.set(syncKey, {
          count: (existing?.count ?? 0) + 1,
          timestamp: Date.now(),
        });

        try {
          const targetSession = this.sessions.fromPartition(targetPartition);
          if (removed) {
            if (url) {
              await targetSession.cookies.remove(url, cookie.name);
            }
          } else if (details) {
            await targetSession.cookies.set(details);
          }
        } catch {
          const current = this.inFlightSync.get(syncKey);
          if (current && current.count > 1) {
            current.count -= 1;
          } else {
            this.inFlightSync.delete(syncKey);
          }
        }
      }),
    );
  }
}
