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

  it("allows identifiers ending in url followed by parentheses", () => {
    expect(containsUnsafeMermaidSource("Go->>AP: POST waitpoint resumeUrl (output body)")).toBe(
      false,
    );
    expect(containsUnsafeMermaidSource("A->>B: fetchUrl (params)")).toBe(false);
    expect(containsUnsafeMermaidSource("A->>B: avatar_url (string)")).toBe(false);
  });

  it("allows prose mentioning URL followed by parenthetical notes", () => {
    expect(
      containsUnsafeMermaidSource(
        "Files-->>UI: Return signed URL (/api/workflow-files/{id}?token=...)",
      ),
    ).toBe(false);
    expect(containsUnsafeMermaidSource("A->>B: signed URL (body)")).toBe(false);
    expect(containsUnsafeMermaidSource("A->>B: canonical URL (https://origin/repo.git)")).toBe(
      false,
    );
  });

  it("allows safe HTML numeric character entities like &#35; while rejecting disguised tags", () => {
    expect(containsUnsafeMermaidSource('graph TD\n A["Issue &#35;123"]')).toBe(false);
    expect(containsUnsafeMermaidSource('graph TD\n A["Status: &#10003; Complete"]')).toBe(false);
    expect(containsUnsafeMermaidSource('graph TD\n A["A &#38; B"]')).toBe(false);
    expect(containsUnsafeMermaidSource('graph TD\n A["&#60;img src=x&#62;"]')).toBe(true);
    expect(containsUnsafeMermaidSource('graph TD\n A["&#x3c;img src=x&#x3e;"]')).toBe(true);
    expect(containsUnsafeMermaidSource('graph TD\n A["&#x3c;script>alert(1)&#x3c;/script>"]')).toBe(
      true,
    );
  });

  it("allows self-closing <i> tags", () => {
    expect(containsUnsafeMermaidSource('graph TD\n A["<i/>icon"]')).toBe(false);
    expect(containsUnsafeMermaidSource('graph TD\n A["<i />icon"]')).toBe(false);
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

  it("does not rewrite a trailing prefix of an allowed tag while it is still streaming", () => {
    expect(neutralizeDisallowedTags('  Middle --> Done["<i')).toBe('  Middle --> Done["<i');
    expect(neutralizeDisallowedTags("line one<br")).toBe("line one<br");
    expect(neutralizeDisallowedTags("line one<b")).toBe("line one<b");
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
  it("keeps a streaming <i label prefix unsafe so the previous SVG is not replaced", () => {
    const streaming = 'flowchart LR\n  Start --> Middle\n  Middle --> Done["<i';
    expect(neutralizeDisallowedTags(streaming)).toBe(streaming);
    expect(containsUnsafeMermaidSource(streaming)).toBe(true);
  });

  it("keeps an unclosed <i> unsafe while the mock provider's 4-char slices fill the label", () => {
    const streaming = 'flowchart LR\n  Start --> Middle\n  Middle --> Done["<i>Don';
    expect(neutralizeDisallowedTags(streaming)).toBe(streaming);
    expect(containsUnsafeMermaidSource(streaming)).toBe(true);
    expect(containsUnsafeMermaidSource(neutralizeDisallowedTags(streaming))).toBe(true);
  });

  it("allows the completed italic label from the mermaid-streaming e2e fixture", () => {
    const complete =
      'flowchart LR\n  Start --> Middle\n  Middle --> Done["<i>Done</i>"]\n  Middle --> Review\n';
    expect(neutralizeDisallowedTags(complete)).toBe(complete);
    expect(containsUnsafeMermaidSource(complete)).toBe(false);
  });

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

  it("allows sequence diagrams with signed URL and placeholders to render", () => {
    const userDiagram = [
      "sequenceDiagram",
      "  autonumber",
      "  actor User as 👤 User",
      "  participant UI as 🖥️ Issue UI (New Issue / Detail)",
      "  participant Files as 📁 Workflow Files (/api/workflow-files)",
      "  participant Go as ⚙️ DeepCycle Go Backend",
      "  participant AP as ⚡ ActivePieces Engine",
      "  participant Ingress as 📥 IngestAPRunEvent",
      "  participant Assignee as 🤖/👤 Assignee (Agent / Human / Squad)",
      "",
      "  User->>UI: Create Issue -> Click Workflow Pill",
      "  UI->>Go: GET /api/workflows?surface=issue&status=published",
      "  Go-->>UI: List of published Issue Trigger workflows",
      "  User->>UI: Pick workflow & fill Inputs form",
      "  opt If File Input Present",
      "    UI->>Files: Upload file to /api/workflow-files",
      "    Files-->>UI: Return signed URL (/api/workflow-files/{id}?token=...)",
      "  end",
      "  UI-->>UI: Save input values on draft",
      "",
      '  alt Auto-run is ON (Default on Create) or "Save & Run" on Existing Issue',
      "    User->>UI: Submit Issue (Auto-run ON)",
      "    UI->>Go: POST /api/issues (workflow_id, workflow_input, auto_run=true)",
      "    Go->>Go: Insert issue row in DB (workflow_id, workflow_input)",
      "    note over Go: Suppress WillEnqueueRun for Assignee",
      "    Go->>Go: Build start payload = { issue: <full_snapshot_at_start>, ...workflow_input }",
      "    Go->>AP: TriggerWebhook(published_flow, payload)",
      "    AP-->>Go: Run started (ap_run_id)",
      "    Go-->>UI: Issue created + Run started",
      "  else Auto-run is OFF (Create with Auto-run toggled off)",
      "    User->>UI: Submit Issue (Auto-run OFF)",
      "    UI->>Go: POST /api/issues (workflow_id, workflow_input, auto_run=false)",
      "    Go->>Go: Insert issue row in DB (workflow_id, workflow_input) - Status: IDLE",
      '    Go-->>UI: Issue created (Workflow row: "Not started" + [Run] button)',
      "    note over User, Go: Later: User clicks [Run] on Workflow row",
      "    User->>UI: Click [Run]",
      "    UI->>Go: POST /api/issues/{id}/workflow/run",
      "    Go->>Go: Read latest issue snapshot + workflow_input",
      "    Go->>AP: TriggerWebhook(published_flow, payload)",
      "    AP-->>Go: Run started (ap_run_id)",
      "  end",
      "",
      "  rect rgb(240, 240, 255)",
      "    note over AP, Assignee: Workflow Execution & Terminal Result Comment",
      "    AP->>AP: Execute workflow steps (e.g. Assign to Agent, Tools, Logic)",
      "    AP->>Ingress: POST /internal/ap/run-events (run.finished)",
      "    Ingress->>Go: ProjectRun (upsert workflow_run, workflow_run_node)",
      "    Go->>Go: Update issue Workflow row status (e.g. Succeeded / Failed)",
      "    Go->>Go: Post result comment on issue with @mention to Assignee",
      "    alt Assignee is Agent",
      "      Go->>Assignee: Enqueue Agent Task (Agent reads result comment & acts)",
      "    else Assignee is Human",
      "      Go->>Assignee: Inbox notification (mentioned)",
      "    else Assignee is Squad",
      "      Go->>Assignee: Enqueue Squad Leader Task",
      "    end",
      "  end",
    ].join("\n");

    expect(containsUnsafeMermaidSource(userDiagram)).toBe(true);
    expect(containsUnsafeMermaidSource(neutralizeDisallowedTags(userDiagram))).toBe(false);
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
