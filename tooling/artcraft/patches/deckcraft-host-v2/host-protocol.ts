import { z } from "zod";

export const HOST_PROTOCOL = 1;
export const HARD_MAX_BYTES = 64 * 1024 * 1024;

const id = z.string().min(1).max(128);
const saveId = z.string().min(1).max(139); // openId + ':' + at most ten sequence digits.

const name = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value === value.trim() &&
      value !== "." &&
      value !== ".." &&
      !/[\\/\p{Cc}\p{Cf}]/u.test(value),
  );

const bytes = z.union([z.instanceof(ArrayBuffer), z.instanceof(Uint8Array)]);

const outputFormat = z
  .object({
    extension: z.enum([
      ".deckcraft",
      ".pptx",
      ".pdf",
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".txt",
      ".rtf",
    ]),
    kind: z.enum(["document", "export"]),
  })
  .refine(
    (format) =>
      (format.extension === ".deckcraft" || format.extension === ".pptx") ===
      (format.kind === "document"),
  );

const envelope = { protocol: z.literal(HOST_PROTOCOL), version: z.string().min(1).max(64) };

const openMessage = z.object({
  ...envelope,
  type: z.literal("deckcraft:open"),
  openId: id,
  name,
  bytes,
  maxBytes: z.number().int().positive().max(HARD_MAX_BYTES),
  writable: z.boolean(),
  replacementName: name.nullable(),
  outputFormats: z.array(outputFormat).min(1).max(32),
});

const acknowledgement = z
  .object({ ...envelope, type: z.literal("deckcraft:save-result"), saveId })
  .and(
    z.discriminatedUnion("status", [
      z.object({ status: z.literal("saved"), revision: z.string().min(1).max(2048) }),
      z.object({
        status: z.enum(["conflict", "read-only", "access-ended", "failed"]),
        message: z.string().min(1).max(2048),
      }),
    ]),
  );

const outgoingPayload = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("deckcraft:ready"),
    supportedInputFormats: z.array(z.enum([".deckcraft", ".pptx"])),
    maxBytes: z.literal(HARD_MAX_BYTES),
    acknowledgements: z.literal(true),
  }),
  z.object({ type: z.literal("deckcraft:opened"), openId: id, name, documentId: id }),
  z.object({
    type: z.literal("deckcraft:save"),
    openId: id,
    saveId,
    name,
    bytes: z.instanceof(Uint8Array),
    saveAs: z.boolean(),
  }),
  z.object({ type: z.literal("deckcraft:saved"), saveId, dirty: z.boolean() }),
  z.object({ type: z.literal("deckcraft:dirty"), dirty: z.boolean() }),
  z.object({ type: z.literal("deckcraft:failed"), error: z.string().max(2048) }),
  z.object({
    type: z.literal("deckcraft:error"),
    operation: z.enum(["open", "save"]),
    operationId: id.optional(),
    error: z.string().max(2048),
  }),
]);

const messageEnvelope = z.object(envelope);

type HostPayload = z.infer<typeof outgoingPayload>;

export const hostOutgoingMessage = outgoingPayload.and(messageEnvelope);

export type HostOutgoing = z.infer<typeof hostOutgoingMessage>;

type OpenMessage = z.infer<typeof openMessage>;

type Acknowledgement = z.infer<typeof acknowledgement>;

type PendingSave = {
  saveId: string;
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
  saveAs: boolean;
  posted: boolean;
};

export interface HostEvent {
  origin: string;
  source: unknown;
  data: unknown;
}

export interface HostPorts {
  origin: string;
  parent: object;
  version: string;
  post(message: HostOutgoing, origin: string): void;
  repaint(): void;
}

function copyBytes(value: ArrayBuffer | Uint8Array, maximum: number): Uint8Array<ArrayBuffer> {
  const view = value instanceof ArrayBuffer ? new Uint8Array(value) : value;

  if (!(view.buffer instanceof ArrayBuffer) || !view.byteLength || view.byteLength > maximum)
    throw new Error("Empty, shared, detached or oversized document buffer");

  return new Uint8Array(view);
}

export function createDeckHostProtocol(ports: HostPorts) {
  const url = new URL(ports.origin);

  if (
    url.origin !== ports.origin ||
    !["http:", "https:"].includes(url.protocol) ||
    !ports.version ||
    ports.version.length > 64
  )
    throw new Error("Invalid exact-origin/version host attachment");

  let phase: "starting" | "awaiting-open" | "opening" | "editing" = "starting";
  let opening: OpenMessage | null = null;
  let openTaken = false;
  let active: { documentId: string; descriptor: Omit<OpenMessage, "bytes"> } | null = null;
  let pending: PendingSave | null = null;
  let ack: Acknowledgement | null = null;
  let confirmedId: string | null = null;
  let sequence = 0;
  let localError: string | null = null;

  function send(payload: HostPayload) {
    ports.post({ ...payload, protocol: HOST_PROTOCOL, version: ports.version }, ports.origin);
  }

  function error(operation: "open" | "save", message: string, operationId?: string) {
    localError = message;

    try {
      send({ type: "deckcraft:error", operation, operationId, error: message });
    } catch {
      /* The local status still retains a failed post. */
    }

    ports.repaint();
  }

  function postPending() {
    if (!pending) return;

    try {
      // No transfer list and no shared view: neither a failed post nor a recipient mutation
      // can detach or alter the only recovery copy.
      send({
        type: "deckcraft:save",
        openId: active!.descriptor.openId,
        saveId: pending.saveId,
        name: pending.name,
        bytes: new Uint8Array(pending.bytes),
        saveAs: pending.saveAs,
      });
      pending.posted = true;
    } catch {
      pending.posted = false;
      localError =
        "Could not post save; the serialized bytes are retained. Save again to resend them.";
      ports.repaint();
    }
  }

  return {
    ready() {
      if (phase !== "starting") return;
      phase = "awaiting-open";
      send({
        type: "deckcraft:ready",
        supportedInputFormats: [".deckcraft", ".pptx"],
        maxBytes: HARD_MAX_BYTES,
        acknowledgements: true,
      });
    },
    receive(event: HostEvent) {
      if (event.origin !== ports.origin || event.source !== ports.parent) return;

      const opened = openMessage.safeParse(event.data);

      if (opened.success) {
        if (opened.data.version !== ports.version) {
          error("open", "Editor asset version mismatch", opened.data.openId);

          return;
        }

        if (phase !== "awaiting-open") {
          error(
            "open",
            "Use a fresh attachment before replacing the open document",
            opened.data.openId,
          );

          return;
        }

        const extension = opened.data.name.slice(opened.data.name.lastIndexOf(".")).toLowerCase();

        if (
          ![".deckcraft", ".pptx"].includes(extension) ||
          new Set(opened.data.outputFormats.map((format) => format.extension)).size !==
            opened.data.outputFormats.length
        ) {
          error("open", "Unsupported or ambiguous presentation format policy", opened.data.openId);

          return;
        }

        try {
          opening = { ...opened.data, bytes: copyBytes(opened.data.bytes, opened.data.maxBytes) };
          openTaken = false;
          phase = "opening";
          ports.repaint();
        } catch {
          error("open", "Invalid or oversized document bytes", opened.data.openId);
        }

        return;
      }

      const result = acknowledgement.safeParse(event.data);

      if (
        !result.success ||
        result.data.version !== ports.version ||
        !pending ||
        result.data.saveId !== pending.saveId
      )
        return;

      if (ack?.status === "saved") return;
      ack = result.data;
      ports.repaint();
    },
    takeOpen() {
      if (!opening || openTaken) return null;
      openTaken = true;

      return { openId: opening.openId, name: opening.name, bytes: opening.bytes };
    },
    opened(openId: string, documentId: string) {
      if (!opening || opening.openId !== openId || phase !== "opening")
        throw new Error("Unexpected open acknowledgement");
      const { bytes: _bytes, ...descriptor } = opening;
      active = { documentId, descriptor };
      opening = null;
      phase = "editing";
      send({ type: "deckcraft:opened", openId, name: descriptor.name, documentId });
    },
    openFailed(openId: string, message: string) {
      if (!opening || opening.openId !== openId) return;
      opening = null;
      phase = "awaiting-open";
      error("open", message.slice(0, 2048), openId);
    },
    save(documentId: string, filename: string, input: Uint8Array, saveAs: boolean): string {
      if (!active || phase !== "editing") throw new Error("No acknowledged host document is open");

      if (active.documentId !== documentId)
        throw new Error("This presentation needs its own host attachment");

      if (pending) {
        if (!pending.posted) {
          postPending();

          return pending.saveId;
        }

        throw new Error(
          "A save still awaits persistence acknowledgement; recovery bytes are retained",
        );
      }

      const filenameResult = name.safeParse(filename);
      const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();

      const format = active.descriptor.outputFormats.find(
        (candidate) => candidate.extension === extension,
      );

      if (!filenameResult.success || !format)
        throw new Error("Output name/format is not authorized by the open descriptor");

      // A read-only document can't be replaced, but an explicit copy doesn't touch it. The host
      // still has to authorize wherever that copy goes.
      if (format.kind === "document" && !active.descriptor.writable && !saveAs)
        throw new Error("The host document is read-only");

      if (sequence >= 0xffff_ffff)
        throw new Error("Host save sequence exhausted; retain recovery before reopening");

      const retained = copyBytes(input, active.descriptor.maxBytes);
      sequence += 1;
      pending = {
        saveId: `${active.descriptor.openId}:${sequence}`,
        name: filename,
        bytes: retained,
        saveAs:
          saveAs || (format.kind === "document" && filename !== active.descriptor.replacementName),
        posted: false,
      };
      postPending();

      return pending.saveId;
    },
    takeAcknowledgement() {
      if (!ack) return null;
      const result = ack;
      ack = null;

      if (result.status === "saved") {
        confirmedId = result.saveId;
        pending = null;
      }

      return result;
    },
    confirmSaved(saveId: string, dirty: boolean) {
      if (confirmedId !== saveId) return;
      confirmedId = null;
      send({ type: "deckcraft:saved", saveId, dirty });
    },
    dirty(value: boolean) {
      if (active) send({ type: "deckcraft:dirty", dirty: value });
    },
    failed(message: string) {
      send({ type: "deckcraft:failed", error: message.slice(0, 2048) });
    },
    reportError(message: string) {
      error("open", message.slice(0, 2048));
    },
    takeLocalError() {
      const error = localError;
      localError = null;

      return error;
    },
    getRecoveryOutput() {
      return pending ? { ...pending, bytes: new Uint8Array(pending.bytes) } : null;
    },
  };
}
