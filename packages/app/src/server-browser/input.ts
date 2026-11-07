import type { ServerBrowserInputEvent } from "@getpaseo/protocol/server-browser/rpc-schemas";

type Modifier = "Alt" | "Control" | "Meta" | "Shift";

const FLUSH_INTERVAL_MS = 33;
const MAX_BATCH = 64;

/**
 * Coalesces viewer input into few requests. Moves and wheel ticks wait up to one frame;
 * presses, releases and keys flush at once so clicks and typing keep their order and latency.
 * Consecutive moves collapse to the latest, consecutive wheel ticks sum.
 */
export class InputBatcher {
  private queue: ServerBrowserInputEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  public constructor(
    private readonly sendBatch: (events: ServerBrowserInputEvent[]) => Promise<unknown>,
  ) {}

  public push(event: ServerBrowserInputEvent, flushNow: boolean): void {
    if (this.disposed) return;
    const last = this.queue.at(-1);
    if (
      event.kind === "mouse" &&
      event.action === "move" &&
      last?.kind === "mouse" &&
      last.action === "move"
    ) {
      this.queue[this.queue.length - 1] = event;
    } else if (event.kind === "wheel" && last?.kind === "wheel") {
      this.queue[this.queue.length - 1] = {
        ...event,
        deltaX: last.deltaX + event.deltaX,
        deltaY: last.deltaY + event.deltaY,
      };
    } else {
      this.queue.push(event);
    }
    if (flushNow || this.queue.length >= MAX_BATCH) {
      this.flush();
      return;
    }
    this.timer ??= setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  public flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.queue.length === 0) return;
    const events = this.queue;
    this.queue = [];
    void this.sendBatch(events);
  }

  public dispose(): void {
    this.flush();
    this.disposed = true;
  }
}

export function mouseButtonOf(button: number): "left" | "right" | "middle" {
  if (button === 2) return "right";
  if (button === 1) return "middle";
  return "left";
}

export function modifiersOf(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): Modifier[] {
  const modifiers: Modifier[] = [];
  if (event.altKey) modifiers.push("Alt");
  if (event.ctrlKey) modifiers.push("Control");
  if (event.metaKey) modifiers.push("Meta");
  if (event.shiftKey) modifiers.push("Shift");
  return modifiers;
}

/**
 * A DOM key event as server browser input. A printable key without Control/Meta carries its
 * text so the page receives keydown, keypress and input; Enter carries "\r" so forms submit.
 */
export function keyboardEventToInput(
  event: {
    key: string;
    code: string;
    keyCode: number;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  },
  action: "down" | "up",
): ServerBrowserInputEvent[] {
  const modifiers = modifiersOf(event);
  const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey;
  let text: string | undefined;
  if (action === "down" && printable) text = event.key;
  if (action === "down" && event.key === "Enter") text = "\r";
  return [
    {
      kind: "key",
      action,
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      ...(text ? { text } : {}),
      ...(modifiers.length > 0 ? { modifiers } : {}),
    },
  ];
}

const NAMED_KEY_CODES: Record<string, { code: string; keyCode: number; text?: string }> = {
  Backspace: { code: "Backspace", keyCode: 8 },
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
};

/** A soft-keyboard special key (Android TextInput onKeyPress) as a down/up pair. */
export function namedKeyPress(key: "Backspace" | "Enter" | "Tab"): ServerBrowserInputEvent[] {
  const definition = NAMED_KEY_CODES[key]!;
  const base = { kind: "key" as const, key, code: definition.code, keyCode: definition.keyCode };
  return [
    { ...base, action: "down", ...(definition.text ? { text: definition.text } : {}) },
    { ...base, action: "up" },
  ];
}
