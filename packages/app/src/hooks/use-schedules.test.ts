import { describe, expect, it } from "vitest";
import { schedulesQueryKey } from "@/hooks/use-schedules";

describe("schedulesQueryKey", () => {
  it("uses only the sorted host identity", () => {
    expect(schedulesQueryKey(["laptop", "local"])).toEqual(["schedules", "laptop|local"]);
    expect(schedulesQueryKey(["local", "laptop"])).toEqual(["schedules", "laptop|local"]);
    expect(JSON.stringify(schedulesQueryKey(["local"]))).not.toContain("connecting");
    expect(JSON.stringify(schedulesQueryKey(["local"]))).not.toContain("offline");
  });
});
