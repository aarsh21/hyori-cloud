import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type HostNetworkEvent = { readonly at: number; readonly interfaceName: string };

// `[timestamp] 123: veth1a2b: <flags> ...`, reduced to when and which: addresses and MACs stay out.
const LINE = /^\[([^\]]+)\]\s+(?:Deleted\s+)?\d+:\s+([^\s:@]+)/;

/**
 * Host address and link changes during a run, watched as they happen. On a shared machine other
 * workloads cause them, and Chromium fails requests over them, so failures can be checked against
 * this rather than assumed either way. Read-only: it only listens.
 */
export function startHostNetworkLog() {
  const events: HostNetworkEvent[] = [];

  const monitor = spawn("ip", ["-ts", "-o", "monitor", "address", "link"], {
    stdio: ["ignore", "pipe", "ignore"],
  });

  createInterface({ input: monitor.stdout }).on("line", (line) => {
    const match = LINE.exec(line);

    if (match?.[1] === undefined || match[2] === undefined) return;

    events.push({ at: new Date(match[1]).getTime(), interfaceName: match[2] });
  });

  return {
    events,
    stop: () => monitor.kill(),
    /** Waits out the changes a just-started stack leaves behind, so they can't fail the first page. */
    async settle(quietMs: number, timeoutMs: number) {
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        const last = events.at(-1)?.at ?? 0;

        if (Date.now() - last >= quietMs) return true;

        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      return false;
    },
  };
}

type FailedRequest = { readonly at: number; readonly reason: string };

const NETWORK_CHANGED = "net::ERR_NETWORK_CHANGED";

/**
 * Whether this run was quiet enough to read its failures as being about the product. A disturbed
 * run isn't excused by this: its failures still count, and it says which ones to look at first.
 */
export function summarizeHostNetwork(
  events: readonly HostNetworkEvent[],
  failures: readonly FailedRequest[],
) {
  const times = events.map(({ at }) => at).toSorted((first, second) => first - second);

  const networkChanged = failures.flatMap(({ at, reason }) => {
    if (reason !== NETWORK_CHANGED) return [];

    const previous = times.findLast((time) => time <= at);

    return [previous === undefined ? null : at - previous];
  });

  return {
    hostNetworkEvents: times.length,
    requestsFailedByNetworkChange: networkChanged.length,
    millisecondsSinceHostEvent: networkChanged,
    quiet: times.length === 0 && networkChanged.length === 0,
  };
}
