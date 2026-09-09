import { describe, expect, test } from "vitest";
import {
  buildCookieUrl,
  cookieToSetDetails,
  type ElectronCookieLike,
  type ElectronCookiesApi,
  type ElectronSessionsWithCookies,
  isLocalhostCookieDomain,
  PaseoBrowserCookieSync,
} from "./browser-cookies.js";

describe("isLocalhostCookieDomain", () => {
  test("identifies direct localhost variants", () => {
    expect(isLocalhostCookieDomain("localhost")).toBe(true);
    expect(isLocalhostCookieDomain(".localhost")).toBe(true);
    expect(isLocalhostCookieDomain("LOCALHOST")).toBe(true);
    expect(isLocalhostCookieDomain("127.0.0.1")).toBe(true);
    expect(isLocalhostCookieDomain(".127.0.0.1")).toBe(true);
    expect(isLocalhostCookieDomain("127.0.1.1")).toBe(true);
    expect(isLocalhostCookieDomain("0.0.0.0")).toBe(true);
    expect(isLocalhostCookieDomain("::1")).toBe(true);
    expect(isLocalhostCookieDomain("[::1]")).toBe(true);
    expect(isLocalhostCookieDomain("::")).toBe(true);
    expect(isLocalhostCookieDomain("[::]")).toBe(true);
  });

  test("identifies localhost service proxy hostnames", () => {
    expect(isLocalhostCookieDomain("dev--main--proj.localhost")).toBe(true);
    expect(isLocalhostCookieDomain(".dev--main--proj.localhost")).toBe(true);
    expect(isLocalhostCookieDomain("api.localhost")).toBe(true);
    expect(isLocalhostCookieDomain("web--feature-branch--app.localhost")).toBe(true);
  });

  test("identifies non-localhost external web domains", () => {
    expect(isLocalhostCookieDomain("github.com")).toBe(false);
    expect(isLocalhostCookieDomain(".github.com")).toBe(false);
    expect(isLocalhostCookieDomain("google.com")).toBe(false);
    expect(isLocalhostCookieDomain("accounts.google.com")).toBe(false);
    expect(isLocalhostCookieDomain("auth0.com")).toBe(false);
    expect(isLocalhostCookieDomain("127.evil.com")).toBe(false);
  });

  test("identifies non-localhost service URLs that proxy to daemon", () => {
    expect(isLocalhostCookieDomain("api--repo.services.example.com")).toBe(false);
    expect(isLocalhostCookieDomain("dev--main--proj.paseoapps.my.domain.com")).toBe(false);
    expect(isLocalhostCookieDomain("3000.preview.example.com")).toBe(false);
    expect(isLocalhostCookieDomain("3000--daemon-1.studio.example.com")).toBe(false);
  });

  test("handles empty and malformed values safely", () => {
    expect(isLocalhostCookieDomain("")).toBe(false);
    expect(isLocalhostCookieDomain(null)).toBe(false);
    expect(isLocalhostCookieDomain(undefined)).toBe(false);
  });
});

describe("buildCookieUrl and cookieToSetDetails", () => {
  test("builds correct URL for secure and non-secure cookies", () => {
    expect(buildCookieUrl({ domain: ".github.com", path: "/login", secure: true })).toBe(
      "https://github.com/login",
    );
    expect(buildCookieUrl({ domain: "localhost", path: "/", secure: false })).toBe(
      "http://localhost/",
    );
    expect(buildCookieUrl({ domain: "[::1]", path: "/api", secure: false })).toBe(
      "http://[::1]/api",
    );
    expect(buildCookieUrl({ domain: "::1", path: "/api", secure: false })).toBe("http://[::1]/api");
  });

  test("converts domain cookie with leading dot", () => {
    const cookie: ElectronCookieLike = {
      name: "session",
      value: "secret",
      domain: ".github.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
    };
    const details = cookieToSetDetails(cookie);
    expect(details.url).toBe("https://github.com/");
    expect(details.domain).toBe(".github.com");
    expect(details.name).toBe("session");
    expect(details.value).toBe("secret");
    expect(details.sameSite).toBe("lax");
    expect(details.secure).toBe(true);
    expect(details.httpOnly).toBe(true);
    expect(details.expirationDate).toBeUndefined();
  });

  test("preserves domain when hostOnly is undefined", () => {
    const cookie: ElectronCookieLike = {
      name: "domain-cookie",
      value: "123",
      domain: "github.com",
      path: "/app",
      secure: true,
      httpOnly: false,
    };
    const details = cookieToSetDetails(cookie);
    expect(details.url).toBe("https://github.com/app");
    expect(details.domain).toBe(".github.com");
  });

  test("converts host-only cookie without setting domain property", () => {
    const cookie: ElectronCookieLike = {
      name: "host-cookie",
      value: "123",
      domain: "github.com",
      hostOnly: true,
      path: "/app",
      secure: true,
      httpOnly: false,
    };
    const details = cookieToSetDetails(cookie);
    expect(details.url).toBe("https://github.com/app");
    expect(details.domain).toBeUndefined();
  });

  test("preserves persistent expirationDate", () => {
    const cookie: ElectronCookieLike = {
      name: "persistent",
      value: "abc",
      domain: ".example.com",
      session: false,
      expirationDate: 1893456000,
    };
    const details = cookieToSetDetails(cookie);
    expect(details.expirationDate).toBe(1893456000);
  });
});

class FakeCookiesApi implements ElectronCookiesApi {
  public readonly cookies: Map<string, ElectronCookieLike> = new Map();
  private readonly listeners = new Set<
    (event: unknown, cookie: ElectronCookieLike, cause: string, removed: boolean) => void
  >();

  public async get(_filter: Record<string, unknown>): Promise<ElectronCookieLike[]> {
    return Array.from(this.cookies.values());
  }

  public async set(details: Record<string, unknown>): Promise<void> {
    const cookie: ElectronCookieLike = {
      name: String(details.name),
      value: String(details.value),
      domain: typeof details.domain === "string" ? details.domain : undefined,
      path: typeof details.path === "string" ? details.path : "/",
      secure: Boolean(details.secure),
      httpOnly: Boolean(details.httpOnly),
      expirationDate:
        typeof details.expirationDate === "number" ? details.expirationDate : undefined,
      sameSite: typeof details.sameSite === "string" ? details.sameSite : undefined,
    };
    const key = `${cookie.domain ?? ""}|${cookie.name}|${cookie.path}`;
    this.cookies.set(key, cookie);
    this.emit("explicit", cookie, false);
  }

  public async remove(_url: string, name: string): Promise<void> {
    for (const [key, cookie] of this.cookies.entries()) {
      if (cookie.name === name) {
        this.cookies.delete(key);
        this.emit("explicit", cookie, true);
        break;
      }
    }
  }

  public on(
    event: "changed",
    listener: (event: unknown, cookie: ElectronCookieLike, cause: string, removed: boolean) => void,
  ): void {
    if (event === "changed") {
      this.listeners.add(listener);
    }
  }

  public emit(cause: string, cookie: ElectronCookieLike, removed: boolean): void {
    for (const listener of this.listeners) {
      listener({}, cookie, cause, removed);
    }
  }
}

class FakeElectronSessions implements ElectronSessionsWithCookies {
  public readonly sessions = new Map<string, { cookies: FakeCookiesApi }>();

  public fromPartition(partition: string): { cookies: FakeCookiesApi } {
    let ses = this.sessions.get(partition);
    if (!ses) {
      ses = { cookies: new FakeCookiesApi() };
      this.sessions.set(partition, ses);
    }
    return ses;
  }
}

describe("PaseoBrowserCookieSync", () => {
  test("syncs non-localhost cookies across active workspace partitions and shared profile", async () => {
    const sessions = new FakeElectronSessions();
    const cookieSync = new PaseoBrowserCookieSync({ sessions });

    const ws1Partition = "persist:paseo-browser-workspace-ws-1";
    const ws2Partition = "persist:paseo-browser-workspace-ws-2";

    await cookieSync.registerWorkspacePartition(ws1Partition);
    await cookieSync.registerWorkspacePartition(ws2Partition);

    // Workspace 1 sets a cookie on github.com
    await sessions.fromPartition(ws1Partition).cookies.set({
      url: "https://github.com/",
      name: "user_session",
      value: "token123",
      domain: ".github.com",
    });

    const ws2Cookies = await sessions.fromPartition(ws2Partition).cookies.get({});
    expect(ws2Cookies).toHaveLength(1);
    expect(ws2Cookies[0].name).toBe("user_session");
    expect(ws2Cookies[0].value).toBe("token123");

    const sharedCookies = await sessions.fromPartition("persist:paseo-browser").cookies.get({});
    expect(sharedCookies).toHaveLength(1);
    expect(sharedCookies[0].name).toBe("user_session");
  });

  test("syncs non-localhost service proxy URLs that proxy to daemon across workspaces", async () => {
    const sessions = new FakeElectronSessions();
    const cookieSync = new PaseoBrowserCookieSync({ sessions });

    const ws1Partition = "persist:paseo-browser-workspace-ws-1";
    const ws2Partition = "persist:paseo-browser-workspace-ws-2";

    await cookieSync.registerWorkspacePartition(ws1Partition);
    await cookieSync.registerWorkspacePartition(ws2Partition);

    // Workspace 1 sets a cookie on a public service proxy URL
    await sessions.fromPartition(ws1Partition).cookies.set({
      url: "https://api--repo.services.example.com/",
      name: "auth_token",
      value: "bearer-xyz",
      domain: "api--repo.services.example.com",
    });

    const ws2Cookies = await sessions.fromPartition(ws2Partition).cookies.get({});
    expect(ws2Cookies).toHaveLength(1);
    expect(ws2Cookies[0].name).toBe("auth_token");
    expect(ws2Cookies[0].value).toBe("bearer-xyz");
  });

  test("does NOT sync localhost cookies (direct or service) across workspaces", async () => {
    const sessions = new FakeElectronSessions();
    const cookieSync = new PaseoBrowserCookieSync({ sessions });

    const ws1Partition = "persist:paseo-browser-workspace-ws-1";
    const ws2Partition = "persist:paseo-browser-workspace-ws-2";

    await cookieSync.registerWorkspacePartition(ws1Partition);
    await cookieSync.registerWorkspacePartition(ws2Partition);

    // Workspace 1 sets a direct localhost cookie
    await sessions.fromPartition(ws1Partition).cookies.set({
      url: "http://localhost:3000/",
      name: "local_dev_token",
      value: "ws1-secret",
      domain: "localhost",
    });

    // Workspace 1 sets a localhost service URL cookie
    await sessions.fromPartition(ws1Partition).cookies.set({
      url: "http://api--repo.localhost:6767/",
      name: "service_session",
      value: "ws1-service",
      domain: "api--repo.localhost",
    });

    const ws2Cookies = await sessions.fromPartition(ws2Partition).cookies.get({});
    expect(ws2Cookies).toHaveLength(0);

    const sharedCookies = await sessions.fromPartition("persist:paseo-browser").cookies.get({});
    expect(sharedCookies).toHaveLength(0);

    const ws1Cookies = await sessions.fromPartition(ws1Partition).cookies.get({});
    expect(ws1Cookies).toHaveLength(2);
  });

  test("syncs initial non-localhost cookies when a new workspace is registered", async () => {
    const sessions = new FakeElectronSessions();
    const cookieSync = new PaseoBrowserCookieSync({ sessions });

    // Pre-populate shared session with a non-localhost cookie and a localhost cookie
    await sessions.fromPartition("persist:paseo-browser").cookies.set({
      url: "https://linear.app/",
      name: "linear_session",
      value: "lin_123",
      domain: ".linear.app",
    });
    await sessions.fromPartition("persist:paseo-browser").cookies.set({
      url: "http://localhost:3000/",
      name: "stale_local",
      value: "ignore_me",
      domain: "localhost",
    });

    const ws3Partition = "persist:paseo-browser-workspace-ws-3";
    await cookieSync.registerWorkspacePartition(ws3Partition);

    const ws3Cookies = await sessions.fromPartition(ws3Partition).cookies.get({});
    expect(ws3Cookies).toHaveLength(1);
    expect(ws3Cookies[0].name).toBe("linear_session");
    expect(ws3Cookies[0].value).toBe("lin_123");
  });

  test("syncs cookie removal across active workspaces", async () => {
    const sessions = new FakeElectronSessions();
    const cookieSync = new PaseoBrowserCookieSync({ sessions });

    const ws1Partition = "persist:paseo-browser-workspace-ws-1";
    const ws2Partition = "persist:paseo-browser-workspace-ws-2";

    await cookieSync.registerWorkspacePartition(ws1Partition);
    await cookieSync.registerWorkspacePartition(ws2Partition);

    await sessions.fromPartition(ws1Partition).cookies.set({
      url: "https://github.com/",
      name: "user_session",
      value: "token123",
      domain: ".github.com",
    });

    expect(await sessions.fromPartition(ws2Partition).cookies.get({})).toHaveLength(1);

    // Remove the cookie in workspace 1
    await sessions
      .fromPartition(ws1Partition)
      .cookies.remove("https://github.com/", "user_session");

    expect(await sessions.fromPartition(ws2Partition).cookies.get({})).toHaveLength(0);
    expect(await sessions.fromPartition("persist:paseo-browser").cookies.get({})).toHaveLength(0);
  });
});
