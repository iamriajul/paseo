import { normalizeWorkspaceBrowserUrl } from "@/desktop/browser/store";
import { resolveWebBrowserSrc } from "./web-preview-url";

// What an address-bar submit means for the frame. Split out of the pane because
// the answer is not the obvious one and is worth pinning: two different strings
// can name the same iframe src, and treating one of those as a navigation breaks
// the bridge.
export type WebSubmitDecision = { kind: "reload" } | { kind: "navigate"; url: string };

export function decideSubmit(input: {
  raw: string;
  template: string | null;
  currentSrc: string | null;
}): WebSubmitDecision {
  const url = normalizeWorkspaceBrowserUrl(input.raw);
  const resolved = resolveWebBrowserSrc({ url, template: input.template });
  const nextSrc = resolved.kind === "no-template" ? null : resolved.src;

  // Same src: React will not re-point the frame, because the `src` prop does not
  // change. Routing this through `user-navigate` would clear `bridgeReady` with
  // no document load to re-announce `ready`, leaving every bridge control dead
  // over a live bridge, and would push a duplicate onto the only history a
  // direct URL has. The pane remounts instead, which reloads — and drags a page
  // that has routed itself away back to the src.
  //
  // Comparing resolved srcs rather than the typed text is what catches
  // `localhost:3000` against a frame already showing `http://localhost:3000/`.
  // The null check matters: with no template nothing resolves, and comparing
  // null to null would swallow every submit as a reload.
  if (nextSrc !== null && nextSrc === input.currentSrc) {
    return { kind: "reload" };
  }
  return { kind: "navigate", url };
}
