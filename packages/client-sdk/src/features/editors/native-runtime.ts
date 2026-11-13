import { Either, Schema } from "@hyori-cloud/lib/effect";

// This is the local frame IPC contract, not the Rust-owned product API. Protocol 3 is the first
// that runs in a sandboxed, opaque-origin frame; earlier runtimes need a same-origin one.
export const NATIVE_HOST_PROTOCOL = 3;
export const NATIVE_HOST_BRIDGE = "hyori-correlated-host-v3";
export const NATIVE_MAX_BYTES = 64 * 1024 * 1024;

export const PDF_ANNOTATION_AUTHOR_VERSIONS: readonly string[] = [
  "0.17.0-hyori-host.4",
  "0.17.0-hyori-host.5",
];

// Keep this leaf contract independent of product RPC schemas: the frame never calls the API.
export const EditorName = Schema.String.pipe(
  Schema.filter((value) => Array.from(value).length >= 1),
  Schema.filter((value) => Array.from(value).length <= 255),
  Schema.filter(
    (value) =>
      value === value.trim() &&
      value !== "." &&
      value !== ".." &&
      !/[\\/\p{Cc}\p{Cf}]/u.test(value),
  ),
);

const id = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128));

const revision = Schema.String.pipe(
  Schema.pattern(/^(0|[1-9]\d{0,19})$/),
  Schema.filter((value) => value.length < 20 || value <= "18446744073709551615"),
);

const version = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64));
const name = EditorName.pipe(Schema.maxLength(255));
const message = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2048));
const maxBytes = Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(NATIVE_MAX_BYTES));

const bytes = Schema.Union(Schema.instanceOf(ArrayBuffer), Schema.Uint8ArrayFromSelf).pipe(
  Schema.filter(
    (value) =>
      value.byteLength > 0 &&
      value.byteLength <= NATIVE_MAX_BYTES &&
      (value instanceof ArrayBuffer || value.buffer instanceof ArrayBuffer),
  ),
);

const envelope = { protocol: Schema.Literal(NATIVE_HOST_PROTOCOL), version };

/** The largest engine the host hands a frame; the server's inventory limit for one file. */
export const NATIVE_MAX_ENGINE_BYTES = 128 * 1024 * 1024;

function type<const Operation extends string>(operation: Operation) {
  return Schema.Literal(
    `wordcraft:${operation}` as const,
    `gridcraft:${operation}` as const,
    `pdfcraft:${operation}` as const,
    `deckcraft:${operation}` as const,
  );
}

export const NativeTheme = Schema.Literal("light", "dark", "system");

export type NativeTheme = typeof NativeTheme.Type;

export const NativeErrorCode = Schema.Literal("busy", "identity-changed", "serialization-failed");

export type NativeErrorCode = typeof NativeErrorCode.Type;

export const NativeIdentity = Schema.Struct({ openId: id, documentId: revision, revision });

export type NativeIdentity = typeof NativeIdentity.Type;

export const NativeSnapshotIdentity = Schema.Struct({
  ...NativeIdentity.fields,
  requestId: id,
  saveId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(139)),
});

export type NativeSnapshotIdentity = typeof NativeSnapshotIdentity.Type;

const outputFormats = Schema.Array(
  Schema.Struct({
    extension: Schema.String.pipe(Schema.pattern(/^\.[a-z0-9]{1,16}$/)),
    kind: Schema.Literal("document", "export"),
    maxBytes: Schema.optional(maxBytes),
  }),
).pipe(Schema.minItems(1), Schema.maxItems(32));

const open = Schema.Struct({
  ...envelope,
  type: type("open"),
  openId: id,
  name,
  bytes,
  annotationAuthor: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(255))),
  writable: Schema.Boolean,
  replacementName: Schema.NullOr(name),
  outputFormats,
  maxBytes,
}).pipe(Schema.filter((value) => value.bytes.byteLength <= value.maxBytes));

const requestSave = Schema.Struct({
  ...envelope,
  type: type("request-save"),
  requestId: id,
  openId: id,
  documentId: revision,
  reason: Schema.Literal("manual", "automatic"),
  intentId: Schema.optional(id),
  saveAs: Schema.optional(Schema.Boolean),
  name: Schema.optional(name),
}).pipe(
  Schema.filter(
    (value) =>
      (value.saveAs === true ? value.name !== undefined : value.name === undefined) &&
      (value.reason !== "automatic" || (value.saveAs !== true && value.intentId === undefined)),
  ),
);

const saveResult = { ...envelope, type: type("save-result"), ...NativeSnapshotIdentity.fields };

export const NativeHostCommand = Schema.Union(
  open,
  requestSave,
  Schema.Struct({
    ...envelope,
    type: type("cancel-intent"),
    openId: id,
    documentId: revision,
    intentId: id,
  }),
  Schema.Struct({ ...envelope, type: type("set-theme"), requestId: id, theme: NativeTheme }),
  Schema.Struct({ ...saveResult, status: Schema.Literal("saved"), fileRevision: message }),
  Schema.Struct({
    ...saveResult,
    status: Schema.Literal("failed", "conflict", "read-only", "access-ended"),
    message,
  }),
  // The engine the descriptor names, verified by the host, or null to load it the ordinary way.
  Schema.Struct({
    ...envelope,
    type: type("engine"),
    bytes: Schema.NullOr(
      Schema.instanceOf(ArrayBuffer).pipe(
        Schema.filter(
          (value) => value.byteLength > 0 && value.byteLength <= NATIVE_MAX_ENGINE_BYTES,
        ),
      ),
    ),
  }),
  // The host moved these bytes to its own recovery and will never persist them: release the
  // snapshot and its native job without marking anything clean. Frames older than this addition
  // reject it as unknown, so hosts follow it with the earlier copy-only release (see SDK).
  Schema.Struct({ ...saveResult, status: Schema.Literal("discarded"), message }),
);

export type NativeHostCommand = typeof NativeHostCommand.Type;

export const NativeHostEvent = Schema.Union(
  // Sent once, before ready, by a frame whose loader wants its engine. It names nothing: the host
  // answers only with the engine of the descriptor it already holds.
  Schema.Struct({ ...envelope, type: type("engine-request") }),
  Schema.Struct({
    ...envelope,
    type: type("ready"),
    capabilities: Schema.Struct({
      serialize: Schema.Literal(true),
      parsedOpen: Schema.Literal(true),
      documentRevision: Schema.Literal(true),
      durableSaveAck: Schema.Literal(true),
      theme: Schema.Literal(true),
    }),
    maxBytes,
  }),
  Schema.Struct({ ...envelope, type: type("opened"), ...NativeIdentity.fields }),
  Schema.Struct({
    ...envelope,
    type: type("dirty"),
    ...NativeIdentity.fields,
    dirty: Schema.Boolean,
  }),
  Schema.Struct({
    ...envelope,
    type: type("save-requested"),
    openId: id,
    documentId: revision,
    intentId: Schema.optional(id),
    saveAs: Schema.Boolean,
    name: Schema.optional(name),
  }).pipe(
    Schema.filter((value) => (value.saveAs ? value.name !== undefined : value.name === undefined)),
  ),
  Schema.Struct({
    ...envelope,
    type: type("save"),
    ...NativeSnapshotIdentity.fields,
    name,
    bytes,
    saveAs: Schema.Boolean,
  }),
  Schema.Struct({
    ...envelope,
    type: type("saved"),
    ...NativeSnapshotIdentity.fields,
    currentRevision: revision,
    dirty: Schema.Boolean,
  }),
  Schema.Struct({
    ...envelope,
    type: type("error"),
    code: NativeErrorCode,
    operation: Schema.Literal("open", "save", "theme"),
    message,
    requestId: Schema.optional(id),
  }),
  Schema.Struct({
    ...envelope,
    type: type("save-paused"),
    ...NativeSnapshotIdentity.fields,
    status: Schema.Literal("failed", "conflict", "read-only", "access-ended"),
    message,
  }),
  Schema.Struct({
    ...envelope,
    type: type("theme-applied"),
    requestId: id,
    theme: NativeTheme,
    resolvedTheme: Schema.Literal("light", "dark"),
  }),
);

export type NativeHostEvent = typeof NativeHostEvent.Type;

const commandDecoder = Schema.decodeUnknownEither(NativeHostCommand, { onExcessProperty: "error" });
const eventDecoder = Schema.decodeUnknownEither(NativeHostEvent, { onExcessProperty: "error" });

export function decodeNativeHostCommand(
  value: Parameters<typeof commandDecoder>[0],
): NativeHostCommand | null {
  const decoded = commandDecoder(value);

  return Either.isRight(decoded) ? decoded.right : null;
}

export function decodeNativeHostEvent(
  value: Parameters<typeof eventDecoder>[0],
): NativeHostEvent | null {
  const decoded = eventDecoder(value);

  return Either.isRight(decoded) ? decoded.right : null;
}
