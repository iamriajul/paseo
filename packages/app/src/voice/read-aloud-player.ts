export type ReadAloudState =
  | { status: "idle" }
  | { status: "rewriting" }
  | { status: "speaking" }
  | { status: "error"; message: string };

export interface ReadAloudSnapshot {
  state: ReadAloudState;
  activeKey: string | null;
}

export interface ReadAloudEngine {
  speak(text: string, key: string): Promise<void>;
  stop(): Promise<void>;
}

export interface ReadAloudPlayer {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ReadAloudSnapshot;
  speakRaw(text: string, key?: string): Promise<void>;
  speakRewritten(text: string, rewrittenText: string, key?: string): Promise<void>;
  stop(): Promise<void>;
}

interface ReadAloudPlayerState {
  snapshot: ReadAloudSnapshot;
  generation: number;
}

export function createReadAloudPlayer(engine: ReadAloudEngine): ReadAloudPlayer {
  const listeners = new Set<() => void>();
  const state: ReadAloudPlayerState = {
    snapshot: { state: { status: "idle" }, activeKey: null },
    generation: 0,
  };

  function emit(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  function patch(snapshot: ReadAloudSnapshot): void {
    state.snapshot = snapshot;
    emit();
  }

  async function speakWithKey(text: string, key: string): Promise<void> {
    const generation = state.generation + 1;
    state.generation = generation;
    patch({ state: { status: "speaking" }, activeKey: key });
    try {
      await engine.speak(text, key);
    } finally {
      if (state.generation === generation) {
        patch({ state: { status: "idle" }, activeKey: null });
      }
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return state.snapshot;
    },
    async speakRaw(text, key?: string) {
      if (!text.trim()) {
        return;
      }
      await speakWithKey(text, typeof key === "string" ? key : text);
    },
    async speakRewritten(_text, rewrittenText, key?: string) {
      if (!rewrittenText.trim()) {
        return;
      }
      await speakWithKey(rewrittenText, typeof key === "string" ? key : rewrittenText);
    },
    async stop() {
      state.generation += 1;
      patch({ state: { status: "idle" }, activeKey: null });
      await engine.stop();
    },
  };
}
