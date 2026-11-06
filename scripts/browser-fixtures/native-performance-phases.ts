import { decodeNativeHostCommand } from "@hyori-cloud/client-sdk/editor-runtime";
import { validatedNativePerformanceEvent } from "./native-performance.ts";
import type { NativePerformanceSnapshot } from "./native-performance.ts";

/** Five new normal profiles, each with one cold and two fresh warm attachments. */
export function nativePerformanceMatrix() {
  return Array.from({ length: 5 }, (_, profile) =>
    ["cold", "warm", "warm"].map((cache, attachment) => ({
      profile,
      attachment,
      cache,
      requiresCleanPreviousClose: attachment > 0,
    })),
  ).flat();
}

/** Observation timings only. Marker/reopen verification and backend durability remain separate. */
export function nativePerformancePhases(snapshot: NativePerformanceSnapshot) {
  const records = snapshot.records.toSorted((a, b) => a.at - b.at);

  const activation = records.find(
    (record) => record.kind === "mark" && record.name === "activation",
  );

  const input = records.find((record) => record.kind === "mark" && record.name === "input-start");

  const ready = records.find((record) =>
    validatedNativePerformanceEvent(record)?.type.endsWith(":ready"),
  );

  const opened = records.find((record) =>
    validatedNativePerformanceEvent(record)?.type.endsWith(":opened"),
  );

  const identity = opened === undefined ? null : validatedNativePerformanceEvent(opened);

  const dirty = records.find((record) => {
    if (
      input === undefined ||
      opened === undefined ||
      record.at < input.at ||
      record.at < opened.at
    )
      return false;

    const event = validatedNativePerformanceEvent(record);

    return (
      event !== null &&
      "dirty" in event &&
      event.dirty === true &&
      event.type.endsWith(":dirty") &&
      identity !== null &&
      "openId" in identity &&
      "openId" in event &&
      event.openId === identity.openId &&
      event.documentId === identity.documentId &&
      event.revision !== identity.revision
    );
  });

  const request = records.find((record) => {
    if (
      dirty === undefined ||
      record.at < dirty.at ||
      record.kind !== "packet" ||
      record.direction !== "host-to-frame" ||
      record.omittedFields !== 0
    )
      return false;

    const command = decodeNativeHostCommand(record.packet);

    return (
      command !== null &&
      "reason" in command &&
      command.saveAs !== true &&
      identity !== null &&
      "openId" in identity &&
      command.openId === identity.openId &&
      command.documentId === identity.documentId
    );
  });

  const output = records.find(
    (record) =>
      request !== undefined &&
      request.kind === "packet" &&
      record.kind === "packet" &&
      record.at >= request.at &&
      record.direction === "frame-to-host" &&
      record.packet.type === `${String(request.packet.type).split(":")[0]}:save` &&
      record.packet.protocol === request.packet.protocol &&
      record.packet.version === request.packet.version &&
      record.packet.openId === request.packet.openId &&
      record.packet.documentId === request.packet.documentId &&
      record.packet.requestId === request.packet.requestId &&
      record.packet.saveAs === false &&
      record.byteLength !== null &&
      record.byteLength > 0,
  );

  const elapsed = (start: { at: number } | undefined, end: { at: number } | undefined) =>
    start !== undefined && end !== undefined && end.at >= start.at ? end.at - start.at : null;

  return {
    activationToReadyMs: elapsed(activation, ready),
    activationToParsedOpenMs: elapsed(activation, opened),
    inputToDirtyObservationMs: elapsed(input, dirty),
    dirtyToCaptureRequestMs: elapsed(dirty, request),
    requestToSnapshotObservationMs: elapsed(request, output),
    // Native saved is not a successful completeSave response, and dirty is not marker fidelity.
    authoritativeDurabilityMs: null,
    isolatedHashingMs: null,
    usableInputVerified: false,
    droppedObservations: snapshot.dropped,
    longTaskCount: records.filter((record) => record.kind === "long-task" && record.duration > 50)
      .length,
  };
}
