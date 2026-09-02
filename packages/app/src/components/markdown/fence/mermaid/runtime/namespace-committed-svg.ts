export const COMMITTED_SVG_ID_PREFIX = "c-";

// mermaid.render writes temp nodes into the iframe document and looks them up
// with document.getElementById / d3 #id selects. Those ids are not unique
// across revisions, so an in-flight render would steal the SVG already in
// #diagram. Prefix committed ids and their url(#) / href references.
export function namespaceCommittedSvg(svg: string): string {
  return svg
    .replace(/url\(#([^)]+)\)/g, `url(#${COMMITTED_SVG_ID_PREFIX}$1)`)
    .replace(/xlink:href="#([^"]+)"/g, `xlink:href="#${COMMITTED_SVG_ID_PREFIX}$1"`)
    .replace(/(^|[^:])href="#([^"]+)"/g, `$1href="#${COMMITTED_SVG_ID_PREFIX}$2"`)
    .replace(/\sid="([^"]+)"/g, ` id="${COMMITTED_SVG_ID_PREFIX}$1"`);
}
