import { describe, expect, test } from "bun:test";
import { summarizeHostNetwork } from "./host-network-log.ts";

const events = [
  { at: 1000, interfaceName: "veth1" },
  { at: 5000, interfaceName: "docker0" },
];

describe("reading a run's host network", () => {
  test("a run with no events and no network failures is quiet", () => {
    expect(summarizeHostNetwork([], [{ at: 1, reason: "net::ERR_ABORTED" }]).quiet).toBe(true);
  });

  test("any host event means the run wasn't quiet, even if nothing failed", () => {
    expect(summarizeHostNetwork(events, []).quiet).toBe(false);
  });

  test("each network failure is measured from the event before it", () => {
    const summary = summarizeHostNetwork(events, [
      { at: 5012, reason: "net::ERR_NETWORK_CHANGED" },
      { at: 1003, reason: "net::ERR_NETWORK_CHANGED" },
      { at: 900, reason: "net::ERR_NETWORK_CHANGED" },
      { at: 6000, reason: "net::ERR_ABORTED" },
    ]);

    expect(summary.requestsFailedByNetworkChange).toBe(3);
    expect(summary.millisecondsSinceHostEvent).toEqual([12, 3, null]);
  });
});
