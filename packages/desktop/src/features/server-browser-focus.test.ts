import { afterEach, describe, expect, it } from "vitest";
import {
  forgetServerBrowserFocus,
  hasFocusedServerBrowser,
  setServerBrowserFocus,
} from "./server-browser-focus.js";

afterEach(() => forgetServerBrowserFocus(1));

describe("server browser focus", () => {
  it("keeps the pane that gained focus when another pane reports losing it afterwards", () => {
    setServerBrowserFocus({ hostWebContentsId: 1, token: "a", focused: true });
    setServerBrowserFocus({ hostWebContentsId: 1, token: "b", focused: true });
    setServerBrowserFocus({ hostWebContentsId: 1, token: "a", focused: false });
    expect(hasFocusedServerBrowser(1)).toBe(true);
    setServerBrowserFocus({ hostWebContentsId: 1, token: "b", focused: false });
    expect(hasFocusedServerBrowser(1)).toBe(false);
  });
});
