import { describe, expect } from "bun:test";
import { useState } from "@hyori-cloud/lib/react";
import type { ReactNode } from "@hyori-cloud/lib/react";
import { CreateUserDialog } from "#features/admin/react/create-user-dialog.tsx";
import { DeleteUserDialog } from "#features/admin/react/delete-user-dialog.tsx";
import { QuotaDialog } from "#features/admin/react/quota-dialog.tsx";
import { RenameDialog } from "#features/files/react/rename-dialog.tsx";
import { VersionHistoryDialog } from "#features/files/react/version-history-dialog.tsx";
import {
  ApiFailure,
  createFakeApi,
  fileEntry,
  fireEvent,
  mount,
  screen,
  SIGNED_IN_USER,
  test,
  waitFor,
} from "#features-test/mounted.tsx";

const USER = { ...SIGNED_IN_USER, status: "active", reservedBytes: 0 } as const;
const FILE = fileEntry({ id: "file_1", name: "a.pdf" });

type DialogProps = { readonly open: boolean; readonly onOpenChange: (open: boolean) => void };

/** The real owners keep dialogs mounted between openings, which is what these regressions need. */
function Reopenable({ dialog }: { dialog: (props: DialogProps) => ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Reopen
      </button>
      {dialog({ open, onOpenChange: setOpen })}
    </>
  );
}

async function closeWithCancel() {
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull());
}

function reopen() {
  fireEvent.click(screen.getByRole("button", { name: "Reopen", hidden: true }));
}

describe("delete user confirmation", () => {
  test("a typed email doesn't survive cancelling and reopening", async () => {
    mount(
      <Reopenable dialog={(props) => <DeleteUserDialog user={USER} {...props} />} />,
      createFakeApi({}),
    );

    reopen();
    const field = await screen.findByLabelText<HTMLInputElement>(/to confirm/);
    const confirm = () => screen.getByRole("button", { name: "Delete account and files" });

    expect(confirm().hasAttribute("disabled")).toBe(true);
    fireEvent.change(field, { target: { value: USER.email } });
    expect(confirm().hasAttribute("disabled")).toBe(false);

    await closeWithCancel();
    reopen();

    const reopened = await screen.findByLabelText<HTMLInputElement>(/to confirm/);

    expect(reopened.value).toBe("");
    expect(confirm().hasAttribute("disabled")).toBe(true);
  });
});

describe("a failed attempt doesn't come back on reopening", () => {
  const FAILED = "Hyori can’t reach its services";

  const failing = (operation: string) =>
    createFakeApi({
      [operation]: () => {
        throw new ApiFailure("service.unavailable");
      },
    });

  test("rename", async () => {
    mount(
      <Reopenable dialog={(props) => <RenameDialog entry={FILE} {...props} />} />,
      failing("files.rename"),
    );

    reopen();
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "b.pdf" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await screen.findByText(FAILED);
    await closeWithCancel();
    reopen();
    await screen.findByLabelText("Name");

    expect(screen.queryByText(FAILED)).toBeNull();
  });

  test("version history", async () => {
    const api = failing("files.restoreVersion");

    api.handlers["files.versions"] = () => ({
      items: [{ id: "v1", fileId: FILE.id, size: 7, createdAt: "2026-11-04T00:00:00Z" }],
      nextCursor: null,
    });

    mount(<Reopenable dialog={(props) => <VersionHistoryDialog entry={FILE} {...props} />} />, api);

    reopen();
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await screen.findByText(FAILED);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Close" })).toBeNull());
    reopen();
    await screen.findByRole("button", { name: "Restore" });

    expect(screen.queryByText(FAILED)).toBeNull();
  });

  test("quota", async () => {
    mount(
      <Reopenable dialog={(props) => <QuotaDialog user={USER} {...props} />} />,
      failing("admin.setQuota"),
    );

    reopen();
    await screen.findByLabelText("Quota in GB");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(FAILED);
    await closeWithCancel();
    reopen();
    await screen.findByLabelText("Quota in GB");

    expect(screen.queryByText(FAILED)).toBeNull();
  });

  test("add user", async () => {
    mount(
      <Reopenable dialog={(props) => <CreateUserDialog {...props} />} />,
      failing("admin.createUser"),
    );

    reopen();
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Grace" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "g@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "long enough pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Add user" }));
    await screen.findByText(FAILED);
    await closeWithCancel();
    reopen();
    await screen.findByLabelText("Name");

    expect(screen.queryByText(FAILED)).toBeNull();
  });
});
