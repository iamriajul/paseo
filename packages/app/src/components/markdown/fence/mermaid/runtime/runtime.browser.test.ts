import { afterEach, describe, expect, it } from "vitest";
import { neutralizeDisallowedTags } from "../source-policy";
import { mermaidRuntimeHtml } from "./html.gen";
import { parseMermaidRuntimeMessage, type MermaidRuntimeMessage } from "./messages";

const mountedFrames: HTMLIFrameElement[] = [];

function waitForRuntimeMessage(
  frame: HTMLIFrameElement,
  predicate: (message: MermaidRuntimeMessage) => boolean,
): Promise<MermaidRuntimeMessage> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", receive);
      reject(new Error("Timed out waiting for Mermaid runtime"));
    }, 10_000);
    function receive(event: MessageEvent): void {
      if (event.source !== frame.contentWindow) {
        return;
      }
      const message = parseMermaidRuntimeMessage(event.data);
      if (!message || !predicate(message)) {
        return;
      }
      window.clearTimeout(timeout);
      window.removeEventListener("message", receive);
      resolve(message);
    }
    window.addEventListener("message", receive);
  });
}

async function mountRuntime(): Promise<HTMLIFrameElement> {
  const frame = document.createElement("iframe");
  frame.sandbox.add("allow-scripts");
  const ready = waitForRuntimeMessage(frame, (message) => message.type === "bridgeReady");
  frame.srcdoc = mermaidRuntimeHtml;
  document.body.append(frame);
  mountedFrames.push(frame);
  await ready;
  return frame;
}

function render(
  frame: HTMLIFrameElement,
  input: { revision: number; source: string },
): Promise<MermaidRuntimeMessage> {
  const response = waitForRuntimeMessage(
    frame,
    (message) =>
      message.type !== "bridgeReady" &&
      "revision" in message &&
      message.revision === input.revision,
  );
  frame.contentWindow?.postMessage(
    {
      type: "render",
      revision: input.revision,
      source: input.source,
      colorScheme: "dark",
      interactive: false,
    },
    "*",
  );
  return response;
}

type RenderedMessage = Extract<MermaidRuntimeMessage, { type: "rendered" }>;

// The frame is sandboxed `allow-scripts` without `allow-same-origin`, so it has an opaque
// origin and `frame.contentDocument` is null from here — permanently, not until it loads.
// The runtime sends `rendered` only after `#diagram.innerHTML = svg`, measuring the
// committed `#diagram svg` bounding box, so non-zero dimensions are the parent's proof
// that an SVG is really in the frame. Label text is asserted in mermaid-streaming.spec.ts,
// which reaches into the frame out-of-process.
function expectRendered(
  message: MermaidRuntimeMessage,
  expected: { revision: number; source: string },
): RenderedMessage {
  expect(message).toMatchObject({ type: "rendered", ...expected });
  if (message.type !== "rendered") {
    throw new Error(`Expected a rendered message, got ${JSON.stringify(message)}`);
  }
  expect(message.width).toBeGreaterThan(0);
  expect(message.height).toBeGreaterThan(0);
  return message;
}

afterEach(() => {
  for (const frame of mountedFrames.splice(0)) {
    frame.remove();
  }
});

describe("Mermaid sandbox runtime", () => {
  it("renders successive valid streaming prefixes and reports an invalid prefix", async () => {
    const frame = await mountRuntime();
    const firstSource = "flowchart TD\nA --> B";
    const secondSource = `${firstSource}\nB --> C`;

    const first = await render(frame, { revision: 1, source: firstSource });
    const invalid = await render(frame, { revision: 2, source: "not a mermaid diagram" });
    const second = await render(frame, { revision: 3, source: secondSource });

    expect(first).toMatchObject({ type: "rendered", revision: 1, source: firstSource });
    expect(invalid).toMatchObject({ type: "renderError", revision: 2 });
    expect(second).toMatchObject({ type: "rendered", revision: 3, source: secondSource });
  });

  it("coalesces queued input and never reports an obsolete result", async () => {
    const frame = await mountRuntime();
    const obsoleteSource = `flowchart TD\n${Array.from({ length: 250 }, (_, index) => `A${index} --> A${index + 1}`).join("\n")}`;
    const currentSource = "flowchart TD\nCurrent --> Result";
    const obsoleteResponses: MermaidRuntimeMessage[] = [];
    function collect(event: MessageEvent): void {
      if (event.source !== frame.contentWindow) {
        return;
      }
      const message = parseMermaidRuntimeMessage(event.data);
      if (message && message.type !== "bridgeReady" && message.revision === 10) {
        obsoleteResponses.push(message);
      }
    }
    window.addEventListener("message", collect);
    frame.contentWindow?.postMessage(
      {
        type: "render",
        revision: 10,
        source: obsoleteSource,
        colorScheme: "dark",
        interactive: false,
      },
      "*",
    );
    const current = await render(frame, { revision: 11, source: currentSource });
    window.removeEventListener("message", collect);

    expect(current).toMatchObject({ type: "rendered", revision: 11, source: currentSource });
    expect(obsoleteResponses).toEqual([]);
  });

  it("commits a complete italic-labelled flowchart over an earlier prefix in the same iframe", async () => {
    const frame = await mountRuntime();
    const prefix = "flowchart LR\n  Start --> Middle\n";
    const complete = [
      "flowchart LR",
      "  Start --> Middle",
      '  Middle --> Done["<i>Done</i>"]',
      "  Middle --> Review",
      "  Review --> Verify",
      "  Verify --> Ship",
      "  Ship --> Package",
      "  Package --> Sign",
      "  Sign --> Upload",
      "  Upload --> Publish",
      "  Publish --> Deploy",
      "  Deploy --> Observe",
      "  Observe --> Validate",
      "  Validate --> Announce",
      "  Announce --> Document",
      "  Document --> Archive",
      "  Archive --> Release",
    ].join("\n");

    const first = expectRendered(await render(frame, { revision: 1, source: prefix }), {
      revision: 1,
      source: prefix,
    });
    const second = expectRendered(await render(frame, { revision: 2, source: complete }), {
      revision: 2,
      source: complete,
    });

    // 17 chained nodes are wider than 2 in an LR flowchart, so the second commit replaced
    // the prefix rather than leaving its SVG in place.
    expect(second.width).toBeGreaterThan(first.width);
  });

  it("renders diagrams containing placeholder-style angle brackets once neutralized", async () => {
    const frame = await mountRuntime();
    const gitProxySource = neutralizeDisallowedTags(
      "sequenceDiagram\n" +
        "    participant A as Agent\n" +
        "    participant D as Daemon\n" +
        "    A->>D: git clone/push  <canonical URL>\n" +
        "    Note over A,D: git wire protocol has NO delete verb → deletion structurally impossible",
    );
    const repoNewSource = neutralizeDisallowedTags(
      "sequenceDiagram\n" +
        "    participant A as Agent\n" +
        "    participant CLI as deepcycle CLI\n" +
        "    A->>CLI: deepcycle repo new <name>\n" +
        "    CLI-->>A: canonical URL<br/>https://<origin>/<ws>/repositories/<name>.git",
    );

    const gitProxy = await render(frame, { revision: 1, source: gitProxySource });
    const repoNew = await render(frame, { revision: 2, source: repoNewSource });

    expect(gitProxy).toMatchObject({ type: "rendered", revision: 1, source: gitProxySource });
    expect(repoNew).toMatchObject({ type: "rendered", revision: 2, source: repoNewSource });
  });

  it("renders sequence diagrams containing signed URL and placeholders once neutralized", async () => {
    const frame = await mountRuntime();
    const sequenceDiagram = neutralizeDisallowedTags(
      [
        "sequenceDiagram",
        "  autonumber",
        "  actor User as 👤 User",
        "  participant UI as 🖥️ Issue UI (New Issue / Detail)",
        "  participant Files as 📁 Workflow Files (/api/workflow-files)",
        "  participant Go as ⚙️ DeepCycle Go Backend",
        "  participant AP as ⚡ ActivePieces Engine",
        "  participant Ingress as 📥 IngestAPRunEvent",
        "  participant Assignee as 🤖/👤 Assignee (Agent / Human / Squad)",
        "  User->>UI: Create Issue -> Click Workflow Pill",
        "  UI->>Go: GET /api/workflows?surface=issue&status=published",
        "  Go-->>UI: List of published Issue Trigger workflows",
        "  User->>UI: Pick workflow & fill Inputs form",
        "  opt If File Input Present",
        "    UI->>Files: Upload file to /api/workflow-files",
        "    Files-->>UI: Return signed URL (/api/workflow-files/{id}?token=...)",
        "  end",
        "  UI-->>UI: Save input values on draft",
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
      ].join("\n"),
    );

    const rendered = await render(frame, { revision: 1, source: sequenceDiagram });
    expectRendered(rendered, { revision: 1, source: sequenceDiagram });
  });
});
