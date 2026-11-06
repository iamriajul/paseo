import { parseHostPort } from "@getpaseo/protocol/daemon-endpoints";
import type { WorkspaceScriptPayload } from "@getpaseo/protocol/messages";
import type { ActiveConnection } from "@/runtime/host-runtime";

export type WorkspaceScriptLinkKind = "public" | "paseo" | "direct";

export interface WorkspaceScriptLinkTarget {
  kind: WorkspaceScriptLinkKind;
  label: string;
  url: string;
}

export interface ResolvedWorkspaceScriptLink {
  primary: WorkspaceScriptLinkTarget | null;
  targets: WorkspaceScriptLinkTarget[];
}

function isLoopbackHost(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase();
  return (
    normalizedHost === "localhost" || normalizedHost === "127.0.0.1" || normalizedHost === "::1"
  );
}

function isLocalOnlyUrl(url: string | null | undefined): boolean {
  if (!url) return true;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return isLoopbackHost(hostname) || hostname.endsWith(".localhost");
  } catch {
    return true;
  }
}

function stripUrlProtocol(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

function buildDirectServiceUrl(
  activeConnection: ActiveConnection | null,
  port: number | null,
): string | null {
  if (port === null) return null;
  if (activeConnection?.type !== "directTcp") {
    return `http://localhost:${port}`;
  }
  try {
    const { host, isIpv6 } = parseHostPort(activeConnection.endpoint);
    let base = host;
    if (isLoopbackHost(host)) {
      base = "localhost";
    } else if (isIpv6) {
      base = `[${host}]`;
    }
    return `http://${base}:${port}`;
  } catch {
    return `http://localhost:${port}`;
  }
}

function addTarget(
  targets: WorkspaceScriptLinkTarget[],
  kind: WorkspaceScriptLinkKind,
  url: string | null | undefined,
): void {
  if (!url || targets.some((target) => target.url === url)) return;
  targets.push({ kind, label: stripUrlProtocol(url), url });
}

export function resolveWorkspaceScriptLink(input: {
  script: WorkspaceScriptPayload;
  activeConnection: ActiveConnection | null;
}): ResolvedWorkspaceScriptLink {
  const { script, activeConnection } = input;
  if (script.type !== "service" || script.lifecycle !== "running") {
    return { primary: null, targets: [] };
  }

  // COMPAT(workspaceScriptSplitUrls): added in v0.2.0, remove after 2027-01-21.
  // Old daemons only send proxyUrl, so classify it by reachability.
  const localProxyUrl =
    script.localProxyUrl ?? (isLocalOnlyUrl(script.proxyUrl) ? script.proxyUrl : null);
  const publicProxyUrl =
    script.publicProxyUrl ?? (!isLocalOnlyUrl(script.proxyUrl) ? script.proxyUrl : null);

  const targets: WorkspaceScriptLinkTarget[] = [];
  addTarget(targets, "public", publicProxyUrl);
  addTarget(targets, "paseo", localProxyUrl);
  addTarget(targets, "direct", buildDirectServiceUrl(activeConnection, script.port));

  return { primary: targets[0] ?? null, targets };
}

/**
 * The URL a service opens at inside the workspace Browser: plain
 * `http://localhost:<port>`. Browser localhost routing sends it to the service on
 * the workspace host, so a service opened from the scripts menu, the ports panel
 * or the Browser's own services menu shares one origin (and one cookie jar)
 * with a localhost tab the user or an agent opened by hand. A public URL stays
 * public: it is reachable as-is and the user picked it on purpose.
 */
export function resolveServiceBrowserUrl(input: {
  script: WorkspaceScriptPayload;
  selected: WorkspaceScriptLinkTarget | null;
}): string | null {
  if (input.selected?.kind === "public") {
    return input.selected.url;
  }
  if (input.script.type !== "service" || input.script.port === null) {
    return input.selected?.url ?? null;
  }
  return `http://localhost:${input.script.port}/`;
}

/** The running service whose port a loopback URL points at, if any. */
export function findServiceForBrowserUrl(input: {
  url: string;
  scripts: readonly WorkspaceScriptPayload[];
}): WorkspaceScriptPayload | null {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return null;
  }
  if (!isLoopbackHost(parsed.hostname.replace(/^\[|\]$/g, "")) && parsed.hostname !== "0.0.0.0") {
    return null;
  }
  const defaultPort = parsed.protocol === "https:" ? 443 : 80;
  const port = parsed.port ? Number(parsed.port) : defaultPort;
  return (
    input.scripts.find(
      (script) =>
        script.type === "service" && script.lifecycle === "running" && script.port === port,
    ) ?? null
  );
}
