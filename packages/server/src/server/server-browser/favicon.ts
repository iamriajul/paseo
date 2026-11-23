/**
 * A server tab's favicon, for every client's tab bar. Headless Chromium fetches no favicons and
 * CDP reports none, so a script in the title observer's isolated world reports the icon the page
 * names (`<link rel=icon>`, else `/favicon.ico`), and the daemon reads its bytes through the
 * page's own network stack (`Network.loadNetworkResource`: the host's localhost, the page's
 * cookies, no CORS). Clients get it as a data: URL, so a phone can show a localhost page's icon.
 */

export const FAVICON_BINDING = "__paseoFavicon";

/** Larger icons are dropped: the tab list carries every tab's icon to every client. */
export const MAX_FAVICON_BYTES = 32 * 1024;

const READ_CHUNK_BYTES = 16 * 1024;

/**
 * Reports the page's icon URL through `FAVICON_BINDING` once per document and whenever its icon
 * links change ("" for a page that cannot have one, such as about:blank).
 */
export function faviconObserverScript(): string {
  return `(() => {
  const report = globalThis[${JSON.stringify(FAVICON_BINDING)}];
  if (typeof report !== "function") return;
  let reported = null;
  const read = () => {
    if (location.protocol !== "http:" && location.protocol !== "https:") return "";
    const links = Array.from(document.querySelectorAll("link[rel~='icon' i][href]"));
    const link = links.find((element) => !/\\bapple-touch-icon\\b/i.test(element.rel)) ?? links[0];
    return link ? link.href : new URL("/favicon.ico", location.href).href;
  };
  const check = () => {
    const href = read();
    if (href === reported) return;
    reported = href;
    report(href);
  };
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      check();
    }, 100);
  };
  new MutationObserver(schedule).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href", "rel"],
  });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", check, { once: true });
  } else {
    check();
  }
})();`;
}

type Send = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * The icon at `url` as a data: URL, or null when it is not an image, is larger than
 * MAX_FAVICON_BYTES, or cannot be read.
 */
export async function readFavicon(
  send: Send,
  frameId: string,
  url: string,
): Promise<string | null> {
  const { resource } = (await send("Network.loadNetworkResource", {
    frameId,
    url,
    options: { disableCache: false, includeCredentials: true },
  })) as {
    resource: {
      success: boolean;
      httpStatusCode?: number;
      stream?: string;
      headers?: Record<string, string>;
    };
  };
  const stream = resource.stream;
  try {
    const status = resource.httpStatusCode ?? 0;
    if (!resource.success || !stream || status < 200 || status >= 300) return null;
    const mime = imageMime(resource.headers ?? {}, url);
    if (!mime) return null;
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const chunk = (await send("IO.read", { handle: stream, size: READ_CHUNK_BYTES })) as {
        data: string;
        base64Encoded?: boolean;
        eof: boolean;
      };
      const bytes = Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8");
      size += bytes.length;
      if (size > MAX_FAVICON_BYTES) return null;
      chunks.push(bytes);
      if (chunk.eof) break;
    }
    if (size === 0) return null;
    return `data:${mime};base64,${Buffer.concat(chunks).toString("base64")}`;
  } finally {
    if (stream) await send("IO.close", { handle: stream }).catch(() => undefined);
  }
}

const ICON_EXTENSIONS: Record<string, string> = {
  ico: "image/x-icon",
  png: "image/png",
  svg: "image/svg+xml",
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** The response's image type; servers that send favicon.ico as octet-stream go by the path. */
function imageMime(headers: Record<string, string>, url: string): string | null {
  const header = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type");
  const type = header?.[1].split(";")[0]?.trim().toLowerCase() ?? "";
  if (/^image\/[a-z0-9.+-]+$/.test(type)) return type;
  if (type && type !== "application/octet-stream") return null;
  const extension = /\.([a-z]+)$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
  return extension ? (ICON_EXTENSIONS[extension] ?? null) : null;
}
