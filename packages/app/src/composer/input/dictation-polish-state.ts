import { useHostFeature } from "@/runtime/host-features";
import { useDictationPolish } from "@/voice/use-dictation-polish";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { resolveDictationPolishAvailability } from "./dictation-polish";

export function useDictationPolishState(client: DaemonClient | null) {
  const supportsFlag = useHostFeature(
    client?.getLastServerInfoMessage()?.serverId,
    "voiceDictationPolish",
  );
  const supportsPolish = resolveDictationPolishAvailability(client, supportsFlag);
  const { isPolishing, polishError, polishTranscript } = useDictationPolish(client);
  return { supportsPolish, isPolishing, polishError, polishTranscript };
}
