/**
 * The mark on Paseo's windows in an Existing browser, where they sit beside their owner's own. CDP
 * cannot name a window, so the mark is the page's title: "Paseo · <workspace> · " + the page's
 * own. Everything Paseo reports strips it again. See docs/server-browser.md, "Existing browser".
 */
const SEPARATOR = " · ";
// The isolated world keeps the observer out of the page's globals; the title itself is shared DOM.
export const WINDOW_TITLE_WORLD = "paseo-window-title";

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
 * Keeps the mark on every document of a tab: on load, and each time the page sets its title
 * (a page that reads its marked title and sets it back gets one mark, not two).
 */
export function windowTitleScript(mark: WindowTitleMark): string {
  return `(() => {
  const label = ${JSON.stringify(mark.label)};
  const prefix = ${JSON.stringify(mark.prefix)};
  const apply = () => {
    const current = document.title;
    const own = current.split(prefix).join("");
    const marked = own && own !== label ? prefix + own : label;
    if (current !== marked) document.title = marked;
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
