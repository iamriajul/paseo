import type { CdpParams } from "./cdp-connection.js";
import type { IsolatedKeyboardInputEvent } from "./engine/trusted-input.js";

interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  /** Text a keyDown inserts when no separate char event follows (Enter submits forms). */
  text?: string;
}

// Electron accelerator names the engine sends (trusted-input aliases arrows to Up/Down/...).
const NAMED_KEYS: Record<string, KeyDefinition> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Space: { key: " ", code: "Space", keyCode: 32 },
  Up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  Down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  Left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  Right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

/** Maps one Electron sendInputEvent keyboard event to CDP Input.dispatchKeyEvent params. */
export function cdpKeyEventsForElectronKey(event: IsolatedKeyboardInputEvent): CdpParams[] {
  if (event.type === "char") {
    return [{ type: "char", text: event.keyCode, unmodifiedText: event.keyCode }];
  }
  const definition = NAMED_KEYS[event.keyCode] ?? characterKey(event.keyCode);
  const base = {
    key: definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.keyCode,
  };
  if (event.type === "keyUp") return [{ type: "keyUp", ...base }];
  // A printable key gets its own char event from the engine, so its keyDown must not insert text.
  return definition.text
    ? [{ type: "keyDown", ...base, text: definition.text, unmodifiedText: definition.text }]
    : [{ type: "rawKeyDown", ...base }];
}

function characterKey(value: string): KeyDefinition {
  if (value.length !== 1) return { key: value, code: value, keyCode: 0 };
  const upper = value.toUpperCase();
  if (/[A-Z]/.test(upper)) return { key: value, code: `Key${upper}`, keyCode: upper.charCodeAt(0) };
  if (/[0-9]/.test(value))
    return { key: value, code: `Digit${value}`, keyCode: value.charCodeAt(0) };
  return { key: value, code: "", keyCode: 0 };
}
