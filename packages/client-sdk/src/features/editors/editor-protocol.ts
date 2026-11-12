import { Either, Schema } from "@hyori-cloud/lib/effect";

import { EditorDocument, EditorName } from "#client-sdk/features/editors/editor-contract";
import { decodeNativeHostCommand } from "#client-sdk/features/editors/native-runtime";
import type {
  BridgedArtCraftApp,
  EditorMessageEvent,
  EditorOutput,
} from "#client-sdk/features/editors/editor-contract";

type EditorMessage =
  | { kind: "ready"; version: string }
  | { kind: "dirty"; dirty: boolean }
  | { kind: "failed"; error: string }
  | {
      kind: "save";
      name: string;
      bytes: Uint8Array<ArrayBuffer>;
      saveAs: boolean;
      openId?: string;
      saveId?: string;
    }
  | { kind: "opened"; openId: string; name: string }
  | { kind: "saved"; saveId: string; dirty: boolean }
  | { kind: "error"; operation: "open" | "save"; operationId?: string; error: string }
  | { kind: "invalid" }
  | { kind: "ignore" };

const Bytes = Schema.Union(Schema.instanceOf(ArrayBuffer), Schema.Uint8ArrayFromSelf);
const decodeBytes = Schema.decodeUnknownEither(Bytes);

const decodeType = Schema.decodeUnknownEither(
  Schema.Struct({
    type: Schema.String.pipe(Schema.maxLength(64)),
    protocol: Schema.optional(Schema.Number),
  }),
);

export function isNativeEditorDocument(document: EditorDocument): boolean {
  return (
    "bridge" in document &&
    document.bridge === "hyori-correlated-host-v2" &&
    "protocol" in document &&
    document.protocol === 2
  );
}

const decodeReady = Schema.decodeUnknownEither(
  Schema.Struct({ version: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)) }),
);

const decodeDirty = Schema.decodeUnknownEither(Schema.Struct({ dirty: Schema.Boolean }));

const decodeFailed = Schema.decodeUnknownEither(
  Schema.Struct({ error: Schema.String.pipe(Schema.maxLength(2048)) }),
);

const decodeSave = Schema.decodeUnknownEither(
  Schema.Struct({ name: EditorName, bytes: Bytes, saveAs: Schema.optional(Schema.Boolean) }),
);

// This separately versioned vendor protocol is not a Hyori backend wire contract.
const deckVersions = ["0.14.1-hyori-host.1", "0.14.1-hyori-host.2"] as const;
const deckMaxBytes = 64 * 1024 * 1024;
const deckName = EditorName.pipe(Schema.maxLength(255));
const correlationId = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128));

const decodeDeckEnvelope = Schema.decodeUnknownEither(
  Schema.Struct({ protocol: Schema.Literal(1), version: Schema.Literal(...deckVersions) }),
);

const decodeDeckReady = Schema.decodeUnknownEither(
  Schema.Struct({ acknowledgements: Schema.Literal(true), maxBytes: Schema.Literal(deckMaxBytes) }),
);

const decodeDeckOpened = Schema.decodeUnknownEither(
  Schema.Struct({ openId: correlationId, name: deckName, documentId: correlationId }),
);

const decodeDeckSaved = Schema.decodeUnknownEither(
  Schema.Struct({
    saveId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(139)),
    dirty: Schema.Boolean,
  }),
);

const decodeDeckSave = Schema.decodeUnknownEither(
  Schema.Struct({
    openId: correlationId,
    saveId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(139)),
    name: deckName,
    bytes: Bytes,
    saveAs: Schema.Boolean,
  }),
);

const decodeDeckError = Schema.decodeUnknownEither(
  Schema.Struct({
    operation: Schema.Literal("open", "save"),
    operationId: Schema.optional(correlationId),
    error: Schema.String.pipe(Schema.maxLength(2048)),
  }),
);

export function copyEditorBytes(
  value: EditorMessageEvent["data"],
  maxBytes: number,
): Uint8Array<ArrayBuffer> | null {
  const decoded = decodeBytes(value);

  if (Either.isLeft(decoded)) return null;

  const view = decoded.right instanceof ArrayBuffer ? new Uint8Array(decoded.right) : decoded.right;

  if (!(view.buffer instanceof ArrayBuffer) || view.byteLength === 0 || view.byteLength > maxBytes)
    return null;

  return new Uint8Array(view);
}

export function decodeEditorReady(
  event: EditorMessageEvent,
): { app: BridgedArtCraftApp; version: string } | null {
  const envelope = decodeType(event.data);
  const ready = decodeReady(event.data);

  if (Either.isLeft(envelope) || Either.isLeft(ready) || envelope.right.protocol === 2) return null;

  switch (envelope.right.type) {
    case "wordcraft:ready":
      return { app: "wordcraft", version: ready.right.version };
    case "gridcraft:ready":
      return { app: "gridcraft", version: ready.right.version };
    case "pdfcraft:ready":
      return { app: "pdfcraft", version: ready.right.version };
    case "deckcraft:ready":
      return Either.isRight(decodeDeckEnvelope(event.data)) &&
        Either.isRight(decodeDeckReady(event.data))
        ? { app: "deckcraft", version: ready.right.version }
        : null;
    default:
      return null;
  }
}

export function decodeEditorMessage(
  event: EditorMessageEvent,
  app: BridgedArtCraftApp,
  maxBytes: number,
  expectedVersion: string,
): EditorMessage {
  const envelope = decodeType(event.data);

  if (Either.isLeft(envelope) || envelope.right.protocol === 2) return { kind: "ignore" };

  if (app === "deckcraft") {
    if (!envelope.right.type.startsWith("deckcraft:")) return { kind: "ignore" };

    const deck = decodeDeckEnvelope(event.data);

    if (Either.isLeft(deck) || deck.right.version !== expectedVersion) return { kind: "invalid" };

    switch (envelope.right.type) {
      case "deckcraft:opened": {
        const value = decodeDeckOpened(event.data);

        return Either.isRight(value) ? { kind: "opened", ...value.right } : { kind: "invalid" };
      }

      case "deckcraft:saved": {
        const value = decodeDeckSaved(event.data);

        return Either.isRight(value) ? { kind: "saved", ...value.right } : { kind: "invalid" };
      }

      case "deckcraft:error": {
        const value = decodeDeckError(event.data);

        return Either.isRight(value) ? { kind: "error", ...value.right } : { kind: "invalid" };
      }

      case "deckcraft:save": {
        const value = decodeDeckSave(event.data);

        if (Either.isLeft(value)) return { kind: "invalid" };
        const bytes = copyEditorBytes(value.right.bytes, maxBytes);

        return bytes ? { kind: "save", ...value.right, bytes } : { kind: "invalid" };
      }

      case "deckcraft:ready":
        if (Either.isLeft(decodeDeckReady(event.data))) return { kind: "invalid" };
        break;
    }
  }

  switch (envelope.right.type) {
    case `${app}:ready`: {
      const ready = decodeReady(event.data);

      return Either.isRight(ready)
        ? { kind: "ready", version: ready.right.version }
        : { kind: "invalid" };
    }

    case `${app}:dirty`: {
      const dirty = decodeDirty(event.data);

      return Either.isRight(dirty)
        ? { kind: "dirty", dirty: dirty.right.dirty }
        : { kind: "invalid" };
    }

    case `${app}:failed`: {
      const failed = decodeFailed(event.data);

      return Either.isRight(failed)
        ? { kind: "failed", error: failed.right.error }
        : { kind: "invalid" };
    }

    case `${app}:save`: {
      const save = decodeSave(event.data);

      if (Either.isLeft(save) || (app !== "gridcraft" && save.right.saveAs === undefined))
        return { kind: "invalid" };

      const bytes = copyEditorBytes(save.right.bytes, maxBytes);

      return bytes
        ? { kind: "save", name: save.right.name, bytes, saveAs: save.right.saveAs === true }
        : { kind: "invalid" };
    }

    default:
      return { kind: "ignore" };
  }
}

export function classifyEditorOutput(
  document: EditorDocument,
  message: Extract<EditorMessage, { kind: "save" }>,
): EditorOutput | null {
  const extension = message.name.slice(message.name.lastIndexOf(".")).toLowerCase();
  const format = document.outputFormats.find((candidate) => candidate.extension === extension);

  if (!format || message.bytes.byteLength > (format.maxBytes ?? document.maxBytes)) return null;

  const intent =
    format.kind === "export"
      ? "export"
      : message.name === document.replacementName && !message.saveAs
        ? "replace"
        : "save-as";

  return { name: message.name, bytes: message.bytes, intent };
}

export function validateEditorDocument(document: EditorDocument, maxBytes: number): void {
  Schema.decodeUnknownSync(EditorDocument)(document);
  Schema.decodeUnknownSync(EditorName)(document.name);

  if (document.replacementName !== null)
    Schema.decodeUnknownSync(EditorName)(document.replacementName);

  if (
    (document.protocol === 2) !== (document.bridge === "hyori-correlated-host-v2") ||
    document.maxBytes <= 0 ||
    document.maxBytes > maxBytes ||
    !document.version ||
    document.version.length > 64 ||
    !document.revision ||
    document.revision.length > 32 ||
    document.outputFormats.length < 1 ||
    document.outputFormats.length > 32 ||
    document.outputFormats.some((format) => !/^\.[a-z0-9]{1,16}$/.test(format.extension)) ||
    new Set(document.outputFormats.map((format) => format.extension)).size !==
      document.outputFormats.length ||
    (document.app === "deckcraft" &&
      !isNativeEditorDocument(document) &&
      (!deckVersions.some((version) => version === document.version) ||
        document.maxBytes > deckMaxBytes ||
        document.name.length > 255 ||
        (document.replacementName?.length ?? 0) > 255))
  ) {
    throw new Error("Invalid editor open descriptor");
  }

  if (
    isNativeEditorDocument(document) &&
    decodeNativeHostCommand({
      type: `${document.app}:open`,
      protocol: 2,
      version: document.version,
      openId: "validation",
      name: document.name,
      bytes: new Uint8Array([1]),
      writable: document.writable,
      replacementName: document.replacementName,
      outputFormats: document.outputFormats,
      maxBytes: document.maxBytes,
    }) === null
  )
    throw new Error("Invalid native editor open descriptor");
}
