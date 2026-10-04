import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const DICTATION_POLISH_TIMEOUT_MS = 30_000;

interface PolishCallState {
  isPolishing: boolean;
  error: string | null;
}

export async function polishDictationTextWithClient(
  client: DaemonClient | null,
  text: string,
  options: {
    timeoutMs: number;
    failedMessage: string;
    onState: (state: PolishCallState) => void;
  },
): Promise<string | null> {
  if (!client) {
    return null;
  }
  options.onState({ isPolishing: true, error: null });
  try {
    const payload = await client.polishDictationText(text, {
      timeout: options.timeoutMs,
    });
    if (payload.error || !payload.polishedText) {
      options.onState({ isPolishing: false, error: options.failedMessage });
      return null;
    }
    options.onState({ isPolishing: false, error: null });
    return payload.polishedText;
  } catch {
    options.onState({ isPolishing: false, error: options.failedMessage });
    return null;
  }
}

export function useDictationPolish(client: DaemonClient | null) {
  const { t } = useTranslation();
  const [isPolishing, setIsPolishing] = useState(false);
  const [polishError, setPolishError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const clearPolishError = useCallback(() => {
    setPolishError(null);
  }, []);

  const polishTranscript = useCallback(
    async (text: string): Promise<string | null> => {
      const requestId = requestRef.current + 1;
      requestRef.current = requestId;
      setPolishError(null);
      const failedMessage = t("message.dictation.polishFailed");
      const polished = await polishDictationTextWithClient(client, text, {
        timeoutMs: DICTATION_POLISH_TIMEOUT_MS,
        failedMessage,
        onState: (state) => {
          if (requestRef.current !== requestId) {
            return;
          }
          setIsPolishing(state.isPolishing);
          setPolishError(state.error);
        },
      });
      if (requestRef.current !== requestId) {
        return null;
      }
      return polished;
    },
    [client, t],
  );

  return { isPolishing, polishError, polishTranscript, clearPolishError };
}
