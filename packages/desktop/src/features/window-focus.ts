export function applyOsFocusSteal(input: {
  platform: string;
  focusApp: (options: { steal: true }) => void;
}): void {
  if (input.platform !== "darwin") {
    return;
  }
  input.focusApp({ steal: true });
}
