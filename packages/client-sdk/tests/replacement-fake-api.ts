import { BeginUpload, UploadInput, UploadPartInput } from "@hyori-cloud/api/rpc";
import type { FetchCapability } from "@hyori-cloud/client-sdk";
import { Schema } from "@hyori-cloud/lib/effect";
import { entry } from "#client-sdk-test/fake-api";

type Session = {
  readonly input: typeof BeginUpload.Type;
  readonly revision: number;
  readonly parts: Map<number, Uint8Array>;
  state: "uploading" | "complete" | "aborted";
};

/** Explicit protocol fake, not evidence of real backend revision checks or storage durability. */
export function replacementAPI() {
  const sessions = new Map<string, Session>();
  const begins: (typeof BeginUpload.Type)[] = [];
  const calls: string[] = [];
  const puts: string[] = [];
  let bytes = new TextEncoder().encode("original");
  let revision = 0;
  let completeFailure: "service.unavailable" | "resource.conflict" | null = null;
  let beginGate: Promise<void> | null = null;
  let abortFailure = false;
  const partGates = new Map<number, Promise<void>>();

  const decodeRequest = Schema.decodeUnknownSync(
    Schema.Struct({ operation: Schema.String, input: Schema.Unknown }),
  );

  const ok = <Value>(value: Value) => Response.json({ ok: true, value });

  const failure = (code: "resource.conflict" | "service.unavailable") =>
    Response.json({ ok: false, error: { code, message: code } }, { status: 409 });

  const status = (uploadId: string, session: Session) => ({
    uploadId,
    chunkSize: 3,
    totalParts: Math.max(1, Math.ceil(session.input.size / 3)),
    parts: [...session.parts].map(([partNumber, part]) => ({ partNumber, size: part.byteLength })),
    state: session.state,
    fileId: session.state === "complete" ? (session.input.replaceId ?? entry.id) : null,
  });

  const fetch: FetchCapability = async (url, init) => {
    const target = String(url);

    if (target.includes("/replacement-binary/")) {
      const [uploadId, part] = target.split("/replacement-binary/")[1]!.split("/");
      const partNumber = Number(part);
      const session = sessions.get(uploadId!)!;
      puts.push(`${uploadId}:${partNumber}`);
      const gate = partGates.get(partNumber);

      if (gate) {
        const signal = init?.signal;
        await new Promise<void>((resolve, reject) => {
          const aborted = () => reject(new DOMException("Aborted", "AbortError"));
          signal?.addEventListener("abort", aborted, { once: true });
          void gate.then(() => {
            signal?.removeEventListener("abort", aborted);
            resolve();
          });
        });
      }

      if (!(init?.body instanceof Blob)) throw new Error("Expected bounded Blob part");
      session.parts.set(partNumber, new Uint8Array(await init.body.arrayBuffer()));

      return new Response(null, { status: 204 });
    }

    const { operation, input } = decodeRequest(await new Response(init?.body).json());
    calls.push(operation);

    if (operation === "uploads.begin") {
      const payload = Schema.decodeUnknownSync(BeginUpload)(input);
      begins.push(payload);
      const uploadId = `replacement_${begins.length}`;
      const session: Session = { input: payload, revision, parts: new Map(), state: "uploading" };
      sessions.set(uploadId, session);
      await beginGate;

      return ok(status(uploadId, session));
    }

    const { uploadId } = Schema.decodeUnknownSync(UploadInput)(input);
    const session = sessions.get(uploadId);

    if (!session) throw new Error(`Unknown test upload ${uploadId}`);

    if (operation === "uploads.status") return ok(status(uploadId, session));

    if (operation === "uploads.part") {
      const { partNumber } = Schema.decodeUnknownSync(UploadPartInput)(input);

      return ok({
        url: `/replacement-binary/${uploadId}/${partNumber}`,
        method: "PUT",
        headers: {},
      });
    }

    if (operation === "uploads.abort") {
      if (abortFailure) return failure("service.unavailable");

      if (session.state === "complete") return failure("resource.conflict");
      session.state = "aborted";

      return ok({ success: true });
    }

    if (operation === "uploads.complete") {
      if (completeFailure) return failure(completeFailure);

      if (session.state !== "complete") {
        if (session.state === "aborted" || session.revision !== revision)
          return failure("resource.conflict");
        bytes = new Uint8Array([...session.parts.values()].flatMap((part) => [...part]));
        revision++;
        session.state = "complete";
      }

      return ok({
        ...entry,
        id: session.input.replaceId ?? entry.id,
        name: session.input.name,
        size: session.input.size,
      });
    }

    throw new Error(`Unexpected replacement fake operation ${operation}`);
  };

  return {
    fetch,
    begins,
    calls,
    puts,
    get bytes() {
      return new TextDecoder().decode(bytes);
    },
    get revision() {
      return revision;
    },
    failComplete: (code: typeof completeFailure) => {
      completeFailure = code;
    },
    failAbort: (fail: boolean) => {
      abortFailure = fail;
    },
    holdBegin: (gate: Promise<void>) => {
      beginGate = gate;
    },
    holdPart: (partNumber: number, gate: Promise<void>) => {
      partGates.set(partNumber, gate);
    },
  };
}
