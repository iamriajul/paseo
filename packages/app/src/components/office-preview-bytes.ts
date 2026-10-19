import type { OfficePreviewKind } from "@/file-explorer/office";

// The native bridge rejects one injected script once the document is large.
// 128 KiB of base64 stays under the size Android and iOS accept per call.
export const OFFICE_PREVIEW_BASE64_CHUNK_CHARS = 128 * 1024;

export type OfficePreviewInbound =
  | { type: "begin"; kind: OfficePreviewKind; width: number; height: number }
  | { type: "chunk"; data: string }
  | { type: "end" };

export interface OfficePreviewAssembly {
  kind: OfficePreviewKind | null;
  width: number;
  height: number;
  chunks: string[];
}

export interface OfficePreviewDocument {
  kind: OfficePreviewKind;
  width: number;
  height: number;
  bytes: Uint8Array;
}

export function createOfficePreviewAssembly(): OfficePreviewAssembly {
  return { kind: null, width: 0, height: 0, chunks: [] };
}

export function officePreviewTransferMessages(input: {
  kind: OfficePreviewKind;
  width: number;
  height: number;
  base64: string;
}): OfficePreviewInbound[] {
  const messages: OfficePreviewInbound[] = [
    { type: "begin", kind: input.kind, width: input.width, height: input.height },
  ];
  for (let index = 0; index < input.base64.length; index += OFFICE_PREVIEW_BASE64_CHUNK_CHARS) {
    messages.push({
      type: "chunk",
      data: input.base64.slice(index, index + OFFICE_PREVIEW_BASE64_CHUNK_CHARS),
    });
  }
  messages.push({ type: "end" });
  return messages;
}

export function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function applyOfficePreviewMessage(
  state: OfficePreviewAssembly,
  message: OfficePreviewInbound,
): { state: OfficePreviewAssembly; document: OfficePreviewDocument | null } {
  if (message.type === "begin") {
    return {
      state: { kind: message.kind, width: message.width, height: message.height, chunks: [] },
      document: null,
    };
  }
  if (message.type === "chunk") {
    return {
      state: { ...state, chunks: [...state.chunks, message.data] },
      document: null,
    };
  }
  if (!state.kind) {
    return { state, document: null };
  }
  return {
    state: createOfficePreviewAssembly(),
    document: {
      kind: state.kind,
      width: state.width,
      height: state.height,
      bytes: bytesFromBase64(state.chunks.join("")),
    },
  };
}
