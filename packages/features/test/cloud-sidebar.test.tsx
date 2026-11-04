import { expect } from "bun:test";
import { CloudScreen } from "#features/cloud/react/cloud-screen.tsx";
import {
  act,
  createFakeApi,
  fileList,
  fireEvent,
  folderEntry,
  mount,
  screen,
  SIGNED_IN_USER,
  test,
  waitFor,
} from "#features-test/mounted.tsx";

const FOLDER = folderEntry({ id: "folder_a", name: "Alpha" });

async function renderSignedIn() {
  const api = createFakeApi({
    "auth.status": () => ({ initialized: true, user: SIGNED_IN_USER }),
    "files.list": () => fileList([FOLDER], null, []),
  });

  mount(<CloudScreen path="/" onNavigate={() => {}} />, api);

  return screen.findByRole<HTMLButtonElement>("button", { name: "Sidebar" });
}

function sidebarState() {
  return screen.getByRole("complementary", { name: "Sidebar" }).dataset.state;
}

test("one toggle keeps its element and focus through collapsing and expanding", async () => {
  const toggle = await renderSignedIn();
  act(() => toggle.focus());
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(sidebarState()).toBe("expanded");

  fireEvent.click(toggle);
  await waitFor(() => expect(sidebarState()).toBe("collapsed"));
  expect(screen.getByRole("button", { name: "Sidebar" })).toBe(toggle);
  expect(document.activeElement).toBe(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");

  fireEvent.click(toggle);
  await waitFor(() => expect(sidebarState()).toBe("expanded"));
  expect(screen.getByRole("button", { name: "Sidebar" })).toBe(toggle);
  expect(document.activeElement).toBe(toggle);
});

test("a collapsed sidebar is remembered in this browser", async () => {
  localStorage.setItem("hyori-sidebar", "collapsed");
  const toggle = await renderSignedIn();
  expect(sidebarState()).toBe("collapsed");

  fireEvent.click(toggle);
  await waitFor(() => expect(localStorage.getItem("hyori-sidebar")).toBe("open"));
});

test("Ctrl+B and Cmd+B toggle the sidebar, and other B combinations do not", async () => {
  await renderSignedIn();

  fireEvent.keyDown(document.body, { key: "b", ctrlKey: true });
  await waitFor(() => expect(sidebarState()).toBe("collapsed"));
  fireEvent.keyDown(document.body, { key: "b", metaKey: true });
  await waitFor(() => expect(sidebarState()).toBe("expanded"));

  fireEvent.keyDown(document.body, { key: "b" });
  fireEvent.keyDown(document.body, { key: "b", ctrlKey: true, shiftKey: true });
  expect(sidebarState()).toBe("expanded");
});
