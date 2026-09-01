const VSCODE_PROXY_PORT_TOKEN = "{{port}}";

export function isLoopbackHttpUrl(value: string): boolean {
  return parseLoopbackHttpUrl(value) !== null;
}

export function rewriteWithVscodeProxyUri(input: {
  url: string;
  vscodeProxyUri: string | null | undefined;
}): string | null {
  const parsed = parseLoopbackHttpUrl(input.url);
  const template = input.vscodeProxyUri?.trim();
  if (!parsed || !template?.includes(VSCODE_PROXY_PORT_TOKEN)) {
    return null;
  }

  const rewrittenBase = template.replaceAll(VSCODE_PROXY_PORT_TOKEN, String(parsed.port));
  try {
    const rewritten = new URL(rewrittenBase);
    rewritten.pathname = joinUrlPath(rewritten.pathname, parsed.url.pathname);
    rewritten.search = parsed.url.search;
    rewritten.hash = parsed.url.hash;
    return rewritten.toString();
  } catch {
    return null;
  }
}

function parseLoopbackHttpUrl(value: string): { url: URL; port: number } | null {
  const raw = value.trim();
  if (!raw) {
    return null;
  }

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    return null;
  }

  let port = parsed.port ? Number.parseInt(parsed.port, 10) : 80;
  if (!parsed.port && parsed.protocol === "https:") {
    port = 443;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return { url: parsed, port };
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return isStandardLoopbackHostname(normalized) || normalized === "::" || normalized === "0.0.0.0";
}

export function isStandardLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1") {
    return true;
  }
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.slice(1).every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

export function isUnspecifiedHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return normalized === "::" || normalized === "0.0.0.0";
}

export function isLoopbackTlsUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return (
      (parsed.protocol === "https:" || parsed.protocol === "wss:") &&
      isLoopbackHostname(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function joinUrlPath(basePath: string, originalPath: string): string {
  const normalizedBase = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const normalizedOriginal = originalPath.startsWith("/") ? originalPath : `/${originalPath}`;
  if (!normalizedBase) {
    return normalizedOriginal;
  }
  return `${normalizedBase}${normalizedOriginal}`;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}
