import { describe, expect, it } from "vitest";
import { containsUnsafeMermaidSource, neutralizeDisallowedTags } from "./source-policy";

describe("containsUnsafeMermaidSource", () => {
  it("rejects resource-bearing constructs", () => {
    expect(containsUnsafeMermaidSource('flowchart TD\n  A@{ img: "https://x/y.png" }')).toBe(true);
    expect(containsUnsafeMermaidSource("flowchart TD\n  A@{ icon: 'pack:name' }")).toBe(true);
    expect(
      containsUnsafeMermaidSource('%%{init: {"themeCSS": "a { color: red }"}}%%\ngraph TD'),
    ).toBe(true);
    expect(containsUnsafeMermaidSource("graph TD\n A[url(http://x)]")).toBe(true);
    expect(containsUnsafeMermaidSource("graph TD\n A[@import 'x']")).toBe(true);
    expect(containsUnsafeMermaidSource('graph TD\n A["<img src=x>"]')).toBe(true);
    expect(containsUnsafeMermaidSource('graph TD\n A["<i class=x>styled</i>"]')).toBe(true);
    expect(containsUnsafeMermaidSource('graph TD\n A["&#60;img src=x&#62;"]')).toBe(true);
    expect(containsUnsafeMermaidSource('graph TD\n A["</b>"]')).toBe(true);
  });

  it("rejects all shape-data constructs, including yaml key evasions", () => {
    expect(containsUnsafeMermaidSource('flowchart TD\n  A@{ "img": "https://x/y.png" }')).toBe(
      true,
    );
    expect(containsUnsafeMermaidSource("flowchart TD\n  A@{ 'img': 'https://x/y.png' }")).toBe(
      true,
    );
    expect(
      containsUnsafeMermaidSource('flowchart TD\n  A@{ "\\u0069mg": "https://x/y.png" }'),
    ).toBe(true);
    expect(
      containsUnsafeMermaidSource('flowchart TD\n  A@{ "\\u{69}mg": "https://x/y.png" }'),
    ).toBe(true);
    expect(containsUnsafeMermaidSource('flowchart TD\n  A@{ "\\x69mg": "https://x/y.png" }')).toBe(
      true,
    );
    expect(
      containsUnsafeMermaidSource('flowchart TD\n  A@{ "\\U00000069mg": "https://attacker/x" }'),
    ).toBe(true);
    expect(containsUnsafeMermaidSource('flowchart TD\n  A@{ "icon": "pack:name" }')).toBe(true);
    expect(
      containsUnsafeMermaidSource(
        'flowchart TD\n  A@{ ? img # comment\n  : "https://attacker/x" }',
      ),
    ).toBe(true);
    expect(
      containsUnsafeMermaidSource(
        'flowchart TD\n  A@{ dummy: &k img\n  ? *k # comment\n  : "https://attacker/x" }',
      ),
    ).toBe(true);
  });

  it("fails closed for malformed or out-of-range escapes without throwing", () => {
    expect(() =>
      containsUnsafeMermaidSource('graph TD\n A["\\u{110000} disguised"]'),
    ).not.toThrow();
    expect(containsUnsafeMermaidSource('graph TD\n A["\\u{110000} disguised"]')).toBe(true);
    expect(() =>
      containsUnsafeMermaidSource('graph TD\n A["\\u{FFFFFF} disguised"]'),
    ).not.toThrow();
    expect(containsUnsafeMermaidSource('graph TD\n A["\\u{FFFFFF} disguised"]')).toBe(true);
  });

  it("allows ordinary diagrams including formatting-only labels", () => {
    expect(containsUnsafeMermaidSource("flowchart TD\n  A[Start] --> B{Choice}")).toBe(false);
    expect(containsUnsafeMermaidSource('graph TD\n A["line one<br>line two"]')).toBe(false);
    expect(containsUnsafeMermaidSource('graph TD\n A["line one<br/>line two"]')).toBe(false);
    expect(containsUnsafeMermaidSource('graph TD\n A["<i>formatted</i>"]')).toBe(false);
    expect(containsUnsafeMermaidSource("sequenceDiagram\n  Alice->>Bob: a < b and x > y")).toBe(
      false,
    );
    expect(containsUnsafeMermaidSource("flowchart TD\n  A@{ shape: rect }")).toBe(true);
  });
});

describe("neutralizeDisallowedTags", () => {
  it("swaps a placeholder-style angle bracket for a lookalike, leaving the rest untouched", () => {
    expect(neutralizeDisallowedTags("A->>D: git clone/push  <canonical URL>")).toBe(
      "A->>D: git clone/push  ‹canonical URL>",
    );
  });

  it("handles multiple occurrences on one line", () => {
    expect(
      neutralizeDisallowedTags(
        "API-->>CLI: canonical URL<br/>https://<origin>/<ws>/repositories/<name>.git",
      ),
    ).toBe("API-->>CLI: canonical URL<br/>https://‹origin>/‹ws>/repositories/‹name>.git");
  });

  it("leaves bare <br> and <i> tags untouched", () => {
    expect(neutralizeDisallowedTags("line one<br>line two")).toBe("line one<br>line two");
    expect(neutralizeDisallowedTags("line one<br/>line two")).toBe("line one<br/>line two");
    expect(neutralizeDisallowedTags("<i>formatted</i>")).toBe("<i>formatted</i>");
  });

  it("neutralizes only the opening bracket of a disallowed tag, leaving a bare close alone", () => {
    expect(neutralizeDisallowedTags("<i class=x>styled</i>")).toBe("‹i class=x>styled</i>");
    expect(neutralizeDisallowedTags("<img src=x>")).toBe("‹img src=x>");
  });

  it("leaves constructs unrelated to the tag heuristic untouched", () => {
    expect(neutralizeDisallowedTags('A@{ img: "https://x/y.png" }')).toBe(
      'A@{ img: "https://x/y.png" }',
    );
    expect(neutralizeDisallowedTags("Alice->>Bob: a < b and x > y")).toBe(
      "Alice->>Bob: a < b and x > y",
    );
  });
});

describe("neutralizeDisallowedTags composed with containsUnsafeMermaidSource", () => {
  it("allows the previously-rejected diagrams from this conversation to render", () => {
    const gitProxySource =
      "sequenceDiagram\n  A->>D: git clone/push  <canonical URL>\n  Note over A,D: plain text";
    const repoNewSource =
      "sequenceDiagram\n  A->>CLI: deepcycle repo new <name>\n  API-->>CLI: canonical URL<br/>https://<origin>/<ws>/repositories/<name>.git";

    expect(containsUnsafeMermaidSource(gitProxySource)).toBe(true);
    expect(containsUnsafeMermaidSource(neutralizeDisallowedTags(gitProxySource))).toBe(false);
    expect(containsUnsafeMermaidSource(repoNewSource)).toBe(true);
    expect(containsUnsafeMermaidSource(neutralizeDisallowedTags(repoNewSource))).toBe(false);
  });

  it("allows a bare disallowed tag through as inert text", () => {
    const source = 'graph TD\n A["<img src=x>"]';
    expect(containsUnsafeMermaidSource(neutralizeDisallowedTags(source))).toBe(false);
  });

  it("still rejects shape-data, url(), @import, themeCSS, and entity-encoded constructs after neutralization", () => {
    const cases = [
      'flowchart TD\n  A@{ img: "https://x/y.png" }',
      "graph TD\n A[url(http://x)]",
      "graph TD\n A[@import 'x']",
      '%%{init: {"themeCSS": "a { color: red }"}}%%\ngraph TD',
      'graph TD\n A["&#60;img src=x&#62;"]',
    ];
    for (const source of cases) {
      expect(containsUnsafeMermaidSource(neutralizeDisallowedTags(source))).toBe(true);
    }
  });

  it("still rejects escape-disguised tags, since neutralization only matches literal brackets", () => {
    const source = 'flowchart TD\n  A["\\u003cimg src=x\\u003e"]';
    expect(neutralizeDisallowedTags(source)).toBe(source);
    expect(containsUnsafeMermaidSource(neutralizeDisallowedTags(source))).toBe(true);
  });
});
