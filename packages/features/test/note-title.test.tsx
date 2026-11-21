import { describe, expect } from "bun:test";
import { NoteTitle } from "#features/notes/react/note-title.tsx";
import {
  ApiFailure,
  createFakeApi,
  fileEntry,
  fireEvent,
  mount,
  screen,
  test,
  waitFor,
} from "#features-test/mounted.tsx";

function note(name: string) {
  return {
    favorite: false,
    file: fileEntry({ id: "note_1", name, mimeType: "application/vnd.hyori.note" }),
    generation: "gen_1",
    metadataRevision: "1",
  };
}

function renameApi() {
  return createFakeApi({
    "notes.rename": (input) => note(String(Object(input).name)),
  });
}

function title() {
  return screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Title" });
}

function renderTitle(name: string, api: ReturnType<typeof createFakeApi>, onEnter = () => {}) {
  return mount(<NoteTitle note={note(name)} editable inputRef={null} onEnter={onEnter} />, api);
}

describe("a note's title, edited in place", () => {
  test("a note the server named by default reads as unnamed", () => {
    renderTitle("Untitled note 3", renameApi());

    expect(title().value).toBe("");
    expect(title().placeholder).toBe("Untitled");
  });

  test("Enter hands off and leaving saves once, fenced by the name it started from", async () => {
    const api = renameApi();
    let entered = 0;

    renderTitle("Untitled note 2", api, () => entered++);
    fireEvent.focus(title());
    fireEvent.change(title(), { target: { value: "Trip to Kyoto\n" } });
    fireEvent.keyDown(title(), { key: "Enter" });
    fireEvent.blur(title());

    expect(entered).toBe(1);
    await waitFor(() => expect(api.callsTo("notes.rename")).toHaveLength(1));
    expect(api.callsTo("notes.rename")[0]!.input).toEqual({
      id: "note_1",
      name: "Trip to Kyoto",
      expectedName: "Untitled note 2",
    });
  });

  test("a blank or unchanged title saves nothing", async () => {
    const api = renameApi();

    renderTitle("Groceries", api);
    fireEvent.focus(title());
    fireEvent.change(title(), { target: { value: "   " } });
    fireEvent.blur(title());
    fireEvent.focus(title());
    fireEvent.change(title(), { target: { value: "Groceries " } });
    fireEvent.blur(title());

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.callsTo("notes.rename")).toHaveLength(0);
    expect(title().value).toBe("Groceries");
  });

  test("a title another note already uses keeps the draft and says what to do", async () => {
    const api = createFakeApi({
      "notes.rename": () => {
        throw new ApiFailure("resource.conflict");
      },
    });

    renderTitle("Untitled note", api);
    fireEvent.focus(title());
    fireEvent.change(title(), { target: { value: "Trip to Kyoto" } });
    fireEvent.blur(title());

    expect(await screen.findByText("Couldn’t use this title")).toBeTruthy();
    expect(title().value).toBe("Trip to Kyoto");

    fireEvent.keyDown(title(), { key: "Escape" });
    expect(title().value).toBe("");
    await waitFor(() => expect(screen.queryByText("Couldn’t use this title")).toBeNull());
  });
});
