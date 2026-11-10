import type { KeyboardFocusScope } from "@/keyboard/actions";

function isElement(value: unknown): value is Element {
  return typeof Element !== "undefined" && value instanceof Element;
}

function getFocusCandidateElements(target: EventTarget | null): Element[] {
  const candidates: Element[] = [];
  const pushUnique = (element: Element | null) => {
    if (!element || candidates.includes(element)) {
      return;
    }
    candidates.push(element);
  };

  if (isElement(target)) {
    pushUnique(target);
  }

  if (typeof Node !== "undefined" && target instanceof Node) {
    pushUnique(isElement(target.parentElement) ? target.parentElement : null);
  }

  if (typeof document !== "undefined" && isElement(document.activeElement)) {
    pushUnique(document.activeElement);
  }

  return candidates;
}

export function resolveKeyboardFocusScope(input: {
  target: EventTarget | null;
  commandCenterOpen: boolean;
}): KeyboardFocusScope {
  const { target, commandCenterOpen } = input;
  const candidates = getFocusCandidateElements(target);
  if (candidates.length === 0) {
    return commandCenterOpen ? "command-center" : "other";
  }

  if (
    candidates.some((element) =>
      Boolean(element.closest("[data-testid='terminal-surface']") || element.closest(".xterm")),
    )
  ) {
    return "terminal";
  }

  if (
    commandCenterOpen &&
    candidates.some((element) =>
      Boolean(
        element.closest("[data-testid='command-center-panel']") ||
        element.closest("[data-testid='command-center-input']"),
      ),
    )
  ) {
    return "command-center";
  }

  if (
    candidates.some((element) => Boolean(element.closest("[data-testid='message-input-root']")))
  ) {
    return "message-input";
  }

  // Fork: the server browser's page takes typing like a text field, which it may well have
  // focused; shortcuts a text field keeps (?, plain letters) go to the page (docs/server-browser.md).
  if (
    candidates.some((element) => Boolean(element.closest("[data-testid='server-browser-surface']")))
  ) {
    return commandCenterOpen ? "command-center" : "editable";
  }

  if (
    candidates.some((element) => {
      const editable = element as HTMLElement;
      if (editable.isContentEditable) {
        return true;
      }
      const tag = element.tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || tag === "select";
    })
  ) {
    return commandCenterOpen ? "command-center" : "editable";
  }

  return commandCenterOpen ? "command-center" : "other";
}
