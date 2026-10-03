import { useSyncExternalStore } from "react";
import {
  createReadAloudPlayer,
  type ReadAloudEngine,
  type ReadAloudPlayer,
} from "./read-aloud-player";

let sharedPlayer: ReadAloudPlayer | null = null;

function getSharedPlayer(engine: ReadAloudEngine) {
  if (!sharedPlayer) {
    sharedPlayer = createReadAloudPlayer(engine);
  }
  return sharedPlayer;
}

export function useReadAloudPlayer(engine: ReadAloudEngine) {
  const player = getSharedPlayer(engine);
  const snapshot = useSyncExternalStore(
    (listener) => player.subscribe(listener),
    () => player.getSnapshot(),
    () => player.getSnapshot(),
  );
  return { player, snapshot };
}

export function resetSharedReadAloudPlayer(): void {
  sharedPlayer = null;
}
