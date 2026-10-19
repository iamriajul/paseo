import { Buffer } from "buffer";
import {
  applyOfficePreviewMessage,
  createOfficePreviewAssembly,
  type OfficePreviewAssembly,
  type OfficePreviewDocument,
  type OfficePreviewInbound,
} from "@/components/office-preview-bytes";

Object.defineProperty(globalThis, "Buffer", { value: Buffer });
Object.defineProperty(globalThis, "process", {
  value: {
    env: { NODE_ENV: "production" },
    nextTick(fn: (...args: unknown[]) => void, ...args: unknown[]) {
      queueMicrotask(() => fn(...args));
    },
  },
});

declare global {
  interface Window {
    ReactNativeWebView?: {
      postMessage?: (data: string) => void;
    };
    __PASEO_OFFICE_PREVIEW_RECEIVE__?: (message: OfficePreviewInbound) => void;
  }
}

function installStyles(css: string): void {
  const style = document.createElement("style");
  style.textContent = `
${css}
html, body, #host {
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
}
#host {
  overflow: auto;
}
`;
  document.head.appendChild(style);
}

function sendToNative(message: { type: "bridgeReady" | "ready" | "failed" }): void {
  window.ReactNativeWebView?.postMessage?.(JSON.stringify(message));
  if (window.parent !== window) {
    window.parent.postMessage(message, "*");
  }
}

export function startOfficePreviewWebView(input: {
  css: string;
  open: (preview: {
    host: HTMLElement;
    data: ArrayBuffer;
    width: number;
    height: number;
  }) => Promise<{ destroy: () => void }>;
}): void {
  installStyles(input.css);
  const host = document.getElementById("host");
  let assembly: OfficePreviewAssembly = createOfficePreviewAssembly();
  let session: { destroy: () => void } | null = null;
  let renderGeneration = 0;

  const destroySession = (current: { destroy: () => void } | null) => {
    try {
      current?.destroy();
    } catch {
      // The library removes its wrapper from the host. A second destroy, or a
      // destroy after the host was cleared, throws NotFoundError.
    }
  };

  const failIfCurrent = (generation: number) => {
    if (generation === renderGeneration) sendToNative({ type: "failed" });
  };

  const renderDocument = async (
    documentToRender: OfficePreviewDocument,
    generation: number,
  ): Promise<void> => {
    if (!host) {
      failIfCurrent(generation);
      return;
    }
    const data = documentToRender.bytes.buffer;
    if (!(data instanceof ArrayBuffer)) {
      failIfCurrent(generation);
      return;
    }
    const nextSession = await input.open({
      host,
      data,
      width: documentToRender.width,
      height: documentToRender.height,
    });
    if (generation !== renderGeneration) {
      destroySession(nextSession);
      return;
    }
    session = nextSession;
    sendToNative({ type: "ready" });
  };

  const receive = (message: OfficePreviewInbound) => {
    let next: ReturnType<typeof applyOfficePreviewMessage>;
    try {
      next = applyOfficePreviewMessage(assembly, message);
    } catch {
      sendToNative({ type: "failed" });
      return;
    }
    assembly = next.state;
    if (!next.document) return;
    renderGeneration += 1;
    const generation = renderGeneration;
    destroySession(session);
    session = null;
    host?.replaceChildren();
    void renderDocument(next.document, generation).catch(() => {
      failIfCurrent(generation);
    });
  };

  window.__PASEO_OFFICE_PREVIEW_RECEIVE__ = receive;
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const data = event.data as OfficePreviewInbound | null;
    if (!data || (data.type !== "begin" && data.type !== "chunk" && data.type !== "end")) return;
    receive(data);
  });

  sendToNative({ type: "bridgeReady" });
}
