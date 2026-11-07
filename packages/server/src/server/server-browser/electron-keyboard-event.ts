// Structural copy of Electron's KeyboardInputEvent, for the vendored engine's trusted-input.ts.
export interface KeyboardInputEvent {
  type:
    | "keyDown"
    | "keyUp"
    | "char"
    | "mouseDown"
    | "mouseUp"
    | "mouseEnter"
    | "mouseLeave"
    | "contextMenu"
    | "mouseWheel"
    | "mouseMove";
  keyCode: string;
  modifiers?: Array<
    | "shift"
    | "control"
    | "ctrl"
    | "alt"
    | "meta"
    | "command"
    | "cmd"
    | "iskeypad"
    | "isautorepeat"
    | "leftbuttondown"
    | "middlebuttondown"
    | "rightbuttondown"
    | "capslock"
    | "numlock"
    | "left"
    | "right"
  >;
}
