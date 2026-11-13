import { afterEach, expect, test } from "bun:test";
import * as Y from "yjs";
import type { RPC } from "@hyori-cloud/client-sdk";
import {
  createCollaborationSession,
  decodeCollaborationBytes,
  encodeCollaborationBytes,
  type CollaborationRecovery,
} from "@hyori-cloud/client-sdk/collaboration";

const sessions: ReturnType<typeof createCollaborationSession>[] = [];
const docs: Y.Doc[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();

  for (const doc of docs.splice(0)) doc.destroy();
});

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;

  while (!check()) {
    if (Date.now() > deadline) throw new Error("Collaboration did not reach the expected state");
    await Bun.sleep(2);
  }
}

function paragraph(doc: Y.Doc) {
  const group = doc.getXmlFragment("prosemirror").get(0);

  if (!(group instanceof Y.XmlElement)) throw new Error("Missing block group");
  const p = group.get(0);

  if (!(p instanceof Y.XmlElement)) throw new Error("Missing paragraph");
  const text = p.get(0);

  if (!(text instanceof Y.XmlText)) throw new Error("Missing text");

  return text;
}

function fixture() {
  const doc = new Y.Doc();
  docs.push(doc);
  const group = new Y.XmlElement("blockGroup");
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText("Starting text")]);
  group.insert(0, [p]);
  doc.getXmlFragment("prosemirror").insert(0, [group]);
  let gate: Promise<void> | undefined;

  const backend: RPC["collaboration"] = {
    async open() {
      return {
        sessionId: "session",
        generation: "generation-1",
        schemaVersion: 1,
        state: encodeCollaborationBytes(Y.encodeStateAsUpdate(doc)),
        sequence: "0",
        writable: true,
        name: "Mina",
        color: "#566b9f",
      };
    },
    async sync(input) {
      if (input.update) Y.applyUpdate(doc, decodeCollaborationBytes(input.update));
      await gate;

      return {
        sequence: "1",
        acknowledged: input.update,
        update: encodeCollaborationBytes(
          Y.encodeStateAsUpdate(doc, decodeCollaborationBytes(input.vector)),
        ),
        writable: true,
        peers: [],
      };
    },
    async close() {
      return { success: true };
    },
  };

  return {
    doc,
    backend,
    hold() {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      return () => {
        gate = undefined;
        release();
      };
    },
  };
}

test("a durable receipt preserves edits made while its batch was in flight", async () => {
  const server = fixture();
  let journal: CollaborationRecovery | null = null;

  const session = createCollaborationSession({
    id: "note",
    backend: server.backend,
    journal: {
      async load() {
        return null;
      },
      async save(value) {
        journal = value;
      },
    },
  });

  sessions.push(session);
  session.subscribe(() => {});
  await until(() => session.getSnapshot().status === "saved");
  await session.flush();
  const release = server.hold();
  paragraph(session.doc).insert(0, "First: ");
  const inFlight = session.flush();
  paragraph(session.doc).insert(paragraph(session.doc).length, " — Second");
  release();
  await inFlight;
  expect(session.getSnapshot().hasUnsavedChanges).toBe(true);
  await until(() => journal !== null);
  await session.flush();
  expect(paragraph(server.doc).toString()).toBe("First: Starting text — Second");
  expect(session.getSnapshot().hasUnsavedChanges).toBe(false);
  await until(() => journal === null);
});

test("continuous typing reaches the shared document before typing stops", async () => {
  const server = fixture();
  const session = createCollaborationSession({ id: "note", backend: server.backend });
  sessions.push(session);
  session.subscribe(() => {});
  await until(() => session.getSnapshot().status === "saved");
  await session.flush();

  for (let index = 0; index < 12; index++) {
    paragraph(session.doc).insert(paragraph(session.doc).length, "x");
    await Bun.sleep(100);
  }

  expect(paragraph(server.doc).toString().startsWith("Starting textx")).toBe(true);
  await session.flush();
  expect(paragraph(server.doc).toString()).toBe("Starting textxxxxxxxxxxxx");
});

test("a recovered branch never merges automatically across a restore generation", async () => {
  const server = fixture();
  const draft = new Y.Doc();
  docs.push(draft);
  Y.applyUpdate(draft, Y.encodeStateAsUpdate(server.doc));
  const vector = Y.encodeStateVector(draft);
  paragraph(draft).insert(0, "Offline: ");

  const recovery = {
    generation: "old-generation",
    state: encodeCollaborationBytes(Y.encodeStateAsUpdate(draft)),
    pending: encodeCollaborationBytes(Y.encodeStateAsUpdate(draft, vector)),
    updatedAt: Date.now(),
  };

  const session = createCollaborationSession({
    id: "note",
    backend: server.backend,
    journal: {
      async load() {
        return recovery;
      },
      async save() {},
    },
  });

  sessions.push(session);
  session.subscribe(() => {});
  await until(() => session.getSnapshot().status === "blocked");
  await session.flush();
  expect(session.getSnapshot().writable).toBe(false);
  expect(session.getSnapshot().hasUnsavedChanges).toBe(true);
  expect(paragraph(session.doc).toString()).toBe("Offline: Starting text");
  expect(paragraph(server.doc).toString()).toBe("Starting text");
});

test("an unreadable retained draft pauses editing rather than overwriting recovery", async () => {
  const server = fixture();
  let retained = "unreadable but retained";

  const session = createCollaborationSession({
    id: "note",
    backend: server.backend,
    journal: {
      async load() {
        throw new Error("Invalid journal");
      },
      async save() {
        retained = "replaced";
      },
    },
  });

  sessions.push(session);
  session.subscribe(() => {});
  await until(() => session.getSnapshot().status === "blocked");
  await session.flush();
  expect(session.getSnapshot().writable).toBe(false);
  expect(session.getSnapshot().recoveryError).toBe(true);
  expect(paragraph(session.doc).toString()).toBe("Starting text");
  expect(retained).toBe("unreadable but retained");
});
