import { describe, expect, test } from "bun:test";
import { createDestinationRequests } from "#features/editors/destination-requests.ts";

const OUTPUT = { name: "copy.docx", intent: "save-as" } as const;

function signal() {
  return new AbortController().signal;
}

describe("asking where a copy should go", () => {
  test("shows the request, then answers with what was chosen", async () => {
    const requests = createDestinationRequests();
    const choice = requests.choose(OUTPUT, { signal: signal() });

    expect(requests.getSnapshot()).toBe(OUTPUT);
    requests.answer({ parentId: "folder_1" });

    expect(await choice).toEqual({ parentId: "folder_1" });
    expect(requests.getSnapshot()).toBeNull();
  });

  test("cancelling answers null, and never a default folder", async () => {
    const requests = createDestinationRequests();
    const choice = requests.choose(OUTPUT, { signal: signal() });

    requests.answer(null);

    expect(await choice).toBeNull();
  });

  test("the root folder is an explicit answer, different from cancelling", async () => {
    const requests = createDestinationRequests();
    const choice = requests.choose(OUTPUT, { signal: signal() });

    requests.answer({ parentId: null });

    expect(await choice).toEqual({ parentId: null });
  });

  test("the session ending withdraws the question", async () => {
    const abort = new AbortController();
    const requests = createDestinationRequests();
    const choice = requests.choose(OUTPUT, { signal: abort.signal });

    abort.abort();

    expect(await choice).toBeNull();
    expect(requests.getSnapshot()).toBeNull();
  });

  test("a newer request replaces one nobody answered, which ends as cancelled", async () => {
    const requests = createDestinationRequests();
    const first = requests.choose(OUTPUT, { signal: signal() });
    const second = requests.choose({ name: "b.pdf", intent: "export" }, { signal: signal() });

    expect(await first).toBeNull();
    expect(requests.getSnapshot()?.name).toBe("b.pdf");
    requests.answer({ parentId: null });
    expect(await second).toEqual({ parentId: null });
  });

  test("aborting an answered request leaves a newer question open", async () => {
    const abort = new AbortController();
    const requests = createDestinationRequests();
    const first = requests.choose(OUTPUT, { signal: abort.signal });

    requests.answer({ parentId: "folder_1" });
    expect(await first).toEqual({ parentId: "folder_1" });
    const second = requests.choose({ name: "b.pdf", intent: "export" }, { signal: signal() });

    abort.abort();
    expect(requests.getSnapshot()?.name).toBe("b.pdf");
    requests.answer({ parentId: null });
    expect(await second).toEqual({ parentId: null });
  });

  test("tells whoever is watching about each change", () => {
    const requests = createDestinationRequests();
    let changes = 0;

    const stop = requests.subscribe(() => {
      changes += 1;
    });

    void requests.choose(OUTPUT, { signal: signal() });
    requests.answer(null);
    stop();
    void requests.choose(OUTPUT, { signal: signal() });

    expect(changes).toBeGreaterThanOrEqual(2);
    requests.answer(null);
  });
});
