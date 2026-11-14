import { describe, expect, it } from "vitest";
import { planRangeResponse } from "./range";

function plan(rangeHeader: string | null, size = 1000) {
  return planRangeResponse({ rangeHeader, size, mimeType: "video/mp4" });
}

describe("planRangeResponse", () => {
  it("answers an open-ended range from its start to the end of the file", () => {
    expect(plan("bytes=0-")).toEqual({
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Content-Range": "bytes 0-999/1000",
        "Content-Length": "1000",
      },
      range: { start: 0, end: 999 },
    });
    expect(plan("bytes=600-").range).toEqual({ start: 600, end: 999 });
  });

  it("answers Safari's two-byte probe with exactly two bytes", () => {
    const probe = plan("bytes=0-1");
    expect(probe.status).toBe(206);
    expect(probe.range).toEqual({ start: 0, end: 1 });
    expect(probe.headers["Content-Length"]).toBe("2");
  });

  it("clamps a range past the end and answers a suffix range", () => {
    expect(plan("bytes=990-5000").range).toEqual({ start: 990, end: 999 });
    expect(plan("bytes=-100").headers["Content-Range"]).toBe("bytes 900-999/1000");
    expect(plan("bytes=-5000").range).toEqual({ start: 0, end: 999 });
  });

  it("refuses a range that starts past the end", () => {
    expect(plan("bytes=1000-")).toEqual({
      status: 416,
      headers: {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Content-Range": "bytes */1000",
        "Content-Length": "0",
      },
      range: null,
    });
    expect(plan("bytes=-0").status).toBe(416);
  });

  it("sends the whole file without a usable single range", () => {
    for (const header of [null, "", "bytes=0-10,20-30", "items=0-1", "bytes=50-10"]) {
      const whole = plan(header);
      expect(whole.status).toBe(200);
      expect(whole.range).toEqual({ start: 0, end: 999 });
      expect(whole.headers["Content-Length"]).toBe("1000");
    }
  });

  it("sends no body for an empty file", () => {
    expect(plan(null, 0)).toMatchObject({ status: 200, range: null });
    expect(plan("bytes=0-", 0).status).toBe(416);
  });
});
