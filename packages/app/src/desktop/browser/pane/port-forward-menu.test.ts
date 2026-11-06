import { describe, expect, it } from "vitest";
import { localUrlFor, mainPortOfUrl, parsePortInput, portsToForward } from "./port-forward-menu";

describe("port forward menu helpers", () => {
  it("forwards the page port first, then ports the page used, then ports the user added", () => {
    expect(
      portsToForward({
        mainPort: 3000,
        observedPorts: [3000, 8080, 24678],
        customPorts: [5432, 8080],
      }),
    ).toEqual([3000, 8080, 24678, 5432]);
  });

  it("opens the same path on this computer at the local port", () => {
    expect(localUrlFor({ url: "http://127.0.0.1:3000/app?x=1#top", localPort: 3000 })).toBe(
      "http://localhost:3000/app?x=1#top",
    );
    expect(localUrlFor({ url: "http://localhost:3000/", localPort: 41234 })).toBe(
      "http://localhost:41234/",
    );
  });

  it("reads ports from URLs and from what the user types", () => {
    expect(mainPortOfUrl("http://localhost:5173/")).toBe(5173);
    expect(mainPortOfUrl("http://localhost/")).toBe(80);
    expect(parsePortInput(" :8080 ")).toBe(8080);
    expect(parsePortInput("70000")).toBeNull();
    expect(parsePortInput("abc")).toBeNull();
  });
});
