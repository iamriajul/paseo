/**
 * The mark on Paseo's windows in an Existing browser, where they sit beside their owner's own. CDP
 * cannot name a window, so the mark is the page's title: "Paseo · <workspace> · " + the page's
 * own. Everything Paseo reports strips it again. See docs/server-browser.md, "Existing browser".
 */
const SEPARATOR = " · ";
// The isolated world keeps the observer and its binding out of the page's globals; the title
// itself is shared DOM.
export const TITLE_WORLD = "paseo-title";
export const TITLE_BINDING = "__paseoTitle";

export interface WindowTitleMark {
  /** "Paseo · <workspace>", the whole title of a page that has none. */
  label: string;
  /** The label and a separator, put before a page's own title. */
  prefix: string;
}

export function windowTitleMark(workspaceName: string | null): WindowTitleMark {
  // The snapshot collapses whitespace in the title; a name collapsed the same way still matches.
  const name = workspaceName?.replace(/\s+/g, " ").trim();
  const label = name ? `Paseo${SEPARATOR}${name}` : "Paseo";
  return { label, prefix: `${label}${SEPARATOR}` };
}

/** The page's own title from a marked one. */
export function stripWindowTitle(title: string, mark: WindowTitleMark): string {
  const own = title.split(mark.prefix).join("");
  return own === mark.label ? "" : own;
}

/** The marked title of an accessibility snapshot's root line, `- document "<title>"`. */
export function stripSnapshotTitle(snapshot: string, mark: WindowTitleMark): string {
  const end = snapshot.indexOf("\n");
  const first = end === -1 ? snapshot : snapshot.slice(0, end);
  const match = /^- document "((?:[^"\\]|\\.)*)"(.*)$/.exec(first);
  if (!match) return snapshot;
  const own = stripWindowTitle(JSON.parse(`"${match[1]}"`) as string, mark);
  const line = `- document${own ? ` ${JSON.stringify(own)}` : ""}${match[2]}`;
  return end === -1 ? line : line + snapshot.slice(end);
}

/**
 * Reports the page's title to the daemon each time the page sets it, through `TITLE_BINDING`:
 * Chromium sends no `Target.targetInfoChanged` for a title set after load. With a mark, it also
 * keeps the mark on every document (a page that reads its marked title and sets it back gets one
 * mark, not two), and reports the marked title once it is in place.
 */
export function titleObserverScript(mark: WindowTitleMark | null): string {
  return `(() => {
  const mark = ${JSON.stringify(mark)};
  const report = globalThis[${JSON.stringify(TITLE_BINDING)}];
  let reported = null;
  const apply = () => {
    const current = document.title;
    if (mark) {
      const own = current.split(mark.prefix).join("");
      const marked = own && own !== mark.label ? mark.prefix + own : mark.label;
      if (current !== marked) {
        document.title = marked;
        return;
      }
    }
    if (current === reported || typeof report !== "function") return;
    reported = current;
    report(current);
  };
  let watched = null;
  const titleObserver = new MutationObserver(apply);
  const watch = () => {
    const element = document.querySelector("title");
    if (element !== watched) {
      titleObserver.disconnect();
      watched = element;
      if (element) titleObserver.observe(element, { childList: true, characterData: true, subtree: true });
    }
    apply();
  };
  new MutationObserver(watch).observe(document, { childList: true, subtree: true });
  watch();
})();`;
}
