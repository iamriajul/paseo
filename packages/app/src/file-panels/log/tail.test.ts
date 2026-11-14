import { describe, expect, it } from "vitest";
import { displayLogLine, LogTail, type ReadBytes } from "./tail";

/** A file on "disk" whose reads are recorded. */
function file(initial: string) {
  let bytes = new TextEncoder().encode(initial);
  const reads: [number, number][] = [];
  const read: ReadBytes = async (offset, length) => {
    reads.push([offset, length]);
    return bytes.slice(offset, offset + length);
  };
  return {
    read,
    reads,
    get size() {
      return bytes.length;
    },
    write(text: string) {
      bytes = new TextEncoder().encode(text);
    },
    append(text: string) {
      const added = new TextEncoder().encode(text);
      const next = new Uint8Array(bytes.length + added.length);
      next.set(bytes);
      next.set(added, bytes.length);
      bytes = next;
    },
  };
}

describe("LogTail", () => {
  it("shows only the last chunk's whole lines, then appends just the new bytes", async () => {
    const disk = file("first line\nsecond\nthird\n");
    const tail = new LogTail(disk.read, 12);
    await tail.sync(disk.size);
    expect(tail.getSnapshot()).toMatchObject({ status: "ready", lines: ["third"], start: 18 });

    disk.append("fourth\nfif");
    await tail.sync(disk.size);
    disk.append("th\n");
    await tail.sync(disk.size);
    expect(tail.getSnapshot().lines).toEqual(["third", "fourth", "fifth"]);
    expect(disk.reads).toEqual([
      [12, 12],
      [24, 10],
      [34, 3],
    ]);
  });

  it("publishes new lines as a new array and leaves the last snapshot as it was", async () => {
    const disk = file("one\ntw");
    const tail = new LogTail(disk.read, 1024);
    await tail.sync(disk.size);
    const before = tail.getSnapshot().lines;
    disk.append("o\nthree\n");
    await tail.sync(disk.size);
    expect(tail.getSnapshot().lines).not.toBe(before);
    expect(before).toEqual(["one", "tw"]);
    expect(tail.getSnapshot().lines).toEqual(["one", "two", "three"]);
  });

  it("loads earlier chunks until the start of the file", async () => {
    const disk = file("a1\nb2\nc3\nd4\n");
    const tail = new LogTail(disk.read, 4);
    await tail.sync(disk.size);
    expect(tail.getSnapshot().lines).toEqual(["d4"]);
    await tail.loadEarlier();
    expect(tail.getSnapshot()).toMatchObject({ lines: ["c3", "d4"], start: 6 });
    await tail.loadEarlier();
    await tail.loadEarlier();
    expect(tail.getSnapshot()).toMatchObject({ lines: ["a1", "b2", "c3", "d4"], start: 0 });
  });

  it("starts over when the file shrinks", async () => {
    const disk = file("old one\nold two\n");
    const tail = new LogTail(disk.read, 1024);
    await tail.sync(disk.size);
    disk.write("new\n");
    await tail.sync(disk.size);
    expect(tail.getSnapshot().lines).toEqual(["new"]);
  });

  it("collapses sizes reported during a read into one read", async () => {
    const disk = file("x\n");
    const tail = new LogTail(disk.read, 1024);
    await tail.sync(disk.size);
    disk.append("y\n");
    const first = tail.sync(disk.size);
    disk.append("z\n");
    void tail.sync(disk.size);
    await first;
    await tail.sync(disk.size);
    expect(tail.getSnapshot().lines).toEqual(["x", "y", "z"]);
    expect(disk.reads.length).toBeLessThanOrEqual(3);
  });

  it("keeps a character split across reads whole", async () => {
    const bytes = new TextEncoder().encode("café\n");
    const tail = new LogTail(async (offset, length) => bytes.slice(offset, offset + length), 1024);
    // The file grew in the middle of "é": the first read ends after its first byte.
    await tail.sync(4);
    await tail.sync(bytes.length);
    expect(tail.getSnapshot().lines).toEqual(["café"]);
  });

  it("drops the oldest lines past its limit and reads them again on request", async () => {
    const disk = file("1\n2\n3\n");
    const tail = new LogTail(disk.read, 1024, 2);
    await tail.sync(disk.size);
    disk.append("4\n");
    await tail.sync(disk.size);
    expect(tail.getSnapshot()).toMatchObject({ lines: ["3", "4"], start: 4 });
    await tail.loadEarlier();
    expect(tail.getSnapshot().lines).toEqual(["1", "2", "3", "4"]);
  });

  it("reports a failed read and recovers on the next sync", async () => {
    let fail = true;
    const tail = new LogTail(async () => {
      if (fail) throw new Error("gone");
      return new TextEncoder().encode("ok\n");
    }, 1024);
    await tail.sync(3);
    expect(tail.getSnapshot()).toMatchObject({ status: "failed", error: "gone" });
    fail = false;
    await tail.sync(3);
    expect(tail.getSnapshot()).toMatchObject({ status: "ready", lines: ["ok"] });
  });
});

describe("displayLogLine", () => {
  it("drops terminal colors, titles and a CRLF carriage return", () => {
    expect(displayLogLine("\u001b[31merror\u001b[0m: \u001b]0;title\u0007done\r")).toBe(
      "error: done",
    );
  });
});
