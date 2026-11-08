import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { ServerMessage, TerminalExitInfo } from "./terminal.js";
import { readTerminalState } from "./test-utils/terminal-state.js";

// A real child that prints and exits immediately loses this race only about 1 run
// in 8, so the pty is faked: the last output and the exit arrive in one tick,
// which is the order node-pty uses once the pty socket closes.
interface FakePty {
  pid: number;
  finish(input: { data: string; exitCode: number }): void;
}

const fakePtys: FakePty[] = [];

vi.mock("node-pty", () => ({
  spawn: () => {
    const dataListeners: Array<(data: string) => void> = [];
    const exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];
    const fake = {
      pid: 4242,
      onData(listener: (data: string) => void) {
        dataListeners.push(listener);
        return { dispose() {} };
      },
      onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
        exitListeners.push(listener);
        return { dispose() {} };
      },
      write() {},
      resize() {},
      kill() {},
      finish({ data, exitCode }: { data: string; exitCode: number }) {
        for (const listener of dataListeners) listener(data);
        for (const listener of exitListeners) listener({ exitCode, signal: 0 });
      },
    };
    fakePtys.push(fake);
    return fake;
  },
}));

const { createTerminal } = await import("./terminal.js");

describe("output that arrives just before the child exits", () => {
  it("reaches the headless terminal, subscribers and the exit info", async () => {
    const session = await createTerminal({
      workspaceId: "ws-test",
      cwd: realpathSync(tmpdir()),
      command: process.execPath,
      args: ["-e", "0"],
    });
    const pty = fakePtys.at(-1)!;

    const events: string[] = [];
    session.subscribe((message: ServerMessage) => {
      if (message.type === "output") events.push(`output:${message.data}`);
    });
    const exited = new Promise<TerminalExitInfo>((resolve) => {
      session.onExit((info) => {
        events.push("exit");
        resolve(info);
      });
    });

    pty.finish({ data: "last words\r\n", exitCode: 3 });
    const exitInfo = await exited;

    expect(events).toEqual(["output:last words\r\n", "exit"]);
    expect(exitInfo).toEqual({ exitCode: 3, signal: null, lastOutputLines: ["last words"] });
    const state = await readTerminalState(session);
    expect(
      state.grid[0]
        .map((cell) => cell.char)
        .join("")
        .trimEnd(),
    ).toBe("last words");
  });
});
