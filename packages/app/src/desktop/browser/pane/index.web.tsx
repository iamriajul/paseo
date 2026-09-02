import { WebBrowserPane, type WebBrowserPaneProps } from "./web-pane";

// Upstream owns this filename; the fork owns everything the web Browser does.
// Keeping the body in ./web-pane makes a sync conflict here one import and one
// element instead of the whole pane, and makes the loss detectable: the fork
// decision greps for this import, so a rebase that resolves the file back to
// upstream fails `npm run fork:verify` instead of silently dropping the pane
// while its toolbar, bridge and reducer stay on disk and green.
// See docs/fork-decisions.md#browser-web-devtools-bridge.
export function BrowserPane(props: WebBrowserPaneProps) {
  return <WebBrowserPane {...props} />;
}
