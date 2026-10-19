import { describe, expect, it } from "vitest";
import {
  OFFICE_PREVIEW_BASE64_CHUNK_CHARS,
  applyOfficePreviewMessage,
  createOfficePreviewAssembly,
  officePreviewTransferMessages,
} from "./office-preview-bytes";

describe("office preview transfer", () => {
  it("reassembles a document split across bridge chunks", () => {
    const original = new Uint8Array(OFFICE_PREVIEW_BASE64_CHUNK_CHARS);
    for (let index = 0; index < original.length; index += 1) {
      original[index] = index % 251;
    }
    const base64 = Buffer.from(original).toString("base64");
    const messages = officePreviewTransferMessages({
      kind: "docx",
      width: 640,
      height: 480,
      base64,
    });

    expect(messages[0]).toEqual({ type: "begin", kind: "docx", width: 640, height: 480 });
    expect(messages.at(-1)).toEqual({ type: "end" });
    expect(messages.filter((message) => message.type === "chunk").length).toBeGreaterThan(1);

    let state = createOfficePreviewAssembly();
    let document = null;
    for (const message of messages) {
      const next = applyOfficePreviewMessage(state, message);
      state = next.state;
      document = next.document;
    }

    expect(document?.kind).toBe("docx");
    expect(document?.width).toBe(640);
    expect(document?.height).toBe(480);
    expect(document?.bytes).toEqual(original);
  });

  it("ignores an end that arrives before the document starts", () => {
    const next = applyOfficePreviewMessage(createOfficePreviewAssembly(), { type: "end" });
    expect(next.document).toBeNull();
  });
});
