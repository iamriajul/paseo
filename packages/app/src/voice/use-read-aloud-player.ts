import { useMemo, useSyncExternalStore } from "react";
import { createOnDeviceReadAloudEngine } from "./read-aloud-engine";
import { createReadAloudPlayer, type ReadAloudPlayer } from "./read-aloud-player";

let sharedPlayer: ReadAloudPlayer | null = null;

function getSharedPlayer(): ReadAloudPlayer {
  if (!sharedPlayer) {
    sharedPlayer = createReadAloudPlayer(createOnDeviceReadAloudEngine());
  }
  return sharedPlayer;
}

export function useReadAloudPlayer() {
  const player = useMemo(getSharedPlayer, []);
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
