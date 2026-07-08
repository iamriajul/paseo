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

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::" ||
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.")
  );
}

function joinUrlPath(basePath: string, originalPath: string): string {
  const normalizedBase = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const normalizedOriginal = originalPath.startsWith("/") ? originalPath : `/${originalPath}`;
  if (!normalizedBase) {
    return normalizedOriginal;
  }
  return `${normalizedBase}${normalizedOriginal}`;
}
