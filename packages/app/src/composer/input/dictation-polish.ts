export interface DictationPolishContext {
  confirmDictationForPolish: () => Promise<string | null>;
  polishTranscript: (text: string) => Promise<string | null>;
  handleDictationTranscript: (text: string, meta: { requestId: string }) => void;
  setAutoSend: (value: boolean) => void;
}

export function createPolishRecordingHandler(ctx: DictationPolishContext) {
  return async () => {
    const raw = await ctx.confirmDictationForPolish();
    if (!raw) {
      return;
    }
    ctx.setAutoSend(false);
    const polished = await ctx.polishTranscript(raw);
    if (!polished) {
      return;
    }
    ctx.handleDictationTranscript(polished, { requestId: "dictation-polish" });
  };
}

export function resolveDictationPolishAvailability(
  client: { isConnected: boolean } | null,
  supportsFlag: boolean,
): boolean {
  if (!client?.isConnected) {
    return false;
  }
  return supportsFlag;
}
