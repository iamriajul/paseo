import { describe, expect, it } from "vitest";
import { namespaceCommittedSvg } from "./namespace-committed-svg";

describe("namespaceCommittedSvg", () => {
  it("prefixes ids and url/href references so mermaid cannot look them up", () => {
    const svg =
      '<svg id="paseo-mermaid-1" xmlns:xlink="http://www.w3.org/1999/xlink">' +
      '<defs><marker id="arrow" markerEnd="url(#arrow)"></marker></defs>' +
      '<use href="#arrow" xlink:href="#arrow"></use>' +
      "</svg>";

    expect(namespaceCommittedSvg(svg)).toBe(
      '<svg id="c-paseo-mermaid-1" xmlns:xlink="http://www.w3.org/1999/xlink">' +
        '<defs><marker id="c-arrow" markerEnd="url(#c-arrow)"></marker></defs>' +
        '<use href="#c-arrow" xlink:href="#c-arrow"></use>' +
        "</svg>",
    );
  });
});
