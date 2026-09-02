import { ERUDA_SCRIPT } from "./eruda-script.js";
import { NAVIGATION_SCRIPT } from "./navigation-script.js";
import { SELECTOR_SCRIPT } from "./selector-script.js";

// </script> inside inline source would close the block early and spill the rest
// of the script into the page as visible text.
function escapeInlineScript(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

export function buildInjectedScripts(): string {
  return [NAVIGATION_SCRIPT, ERUDA_SCRIPT, SELECTOR_SCRIPT]
    .map((source) => `<script>${escapeInlineScript(source)}</script>`)
    .join("");
}
