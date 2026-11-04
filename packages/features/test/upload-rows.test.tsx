import { describe, expect } from "bun:test";
import type { UploadEntry, UploadSnapshot, UploadTask } from "@hyori-cloud/client-sdk";
import { AccessRecoveryProvider } from "#features/shared/react/access-recovery.tsx";
import { InterruptedUploadRow } from "#features/uploads/react/interrupted-upload-row.tsx";
import { StartedUploadRow } from "#features/uploads/react/started-upload-row.tsx";
import { UploadsProvider } from "#features/uploads/react/uploads-provider.tsx";
import { createFakeApi, fireEvent, mount, screen, test, waitFor } from "#features-test/mounted.tsx";

function taskIn(snapshot: UploadSnapshot) {
  const task: UploadTask = {
    result: new Promise(() => {}),
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    pause: () => {},
    cancel: async () => {},
    retry: () => new Promise(() => {}),
    dispose: () => {},
  };

  return task;
}

const PROGRESS = { uploadedBytes: 4, totalBytes: 8, checkpoint: null, error: null, file: null };

function startedRow(snapshot: UploadSnapshot) {
  return (
    <UploadsProvider scope={null}>
      <StartedUploadRow id="upload_1" name="a.bin" task={taskIn(snapshot)} />
    </UploadsProvider>
  );
}

function cancelButton() {
  return screen.getByRole("button", { name: "Cancel upload of a.bin" });
}

describe("upload rows", () => {
  test("cancel can't be pressed while the upload is committing", () => {
    mount(startedRow({ ...PROGRESS, status: "finalizing" }), createFakeApi({}));

    expect(screen.getByText("Finishing up")).toBeTruthy();
    expect(cancelButton().hasAttribute("disabled")).toBe(true);
  });

  test("cancelling offers no action until the server confirms", () => {
    mount(startedRow({ ...PROGRESS, status: "cancelling" }), createFakeApi({}));

    expect(screen.getByText("Cancelling…")).toBeTruthy();
    expect(cancelButton().hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: /Retry|Resume|Remove/ })).toBeNull();
  });

  test("an uploading row can still be cancelled", () => {
    mount(startedRow({ ...PROGRESS, status: "uploading" }), createFakeApi({}));

    expect(cancelButton().hasAttribute("disabled")).toBe(false);
  });

  test("a failure from a lost public grant offers recovery rather than sign-in copy", async () => {
    const recovered: string[] = [];

    mount(
      <AccessRecoveryProvider
        value={() => ({
          title: "Your access through this link has ended",
          detail: "Open the link again to continue.",
          actionLabel: "Open link again",
          pendingLabel: "Opening…",
          pending: false,
          recover: () => void recovered.push("reopen"),
        })}
      >
        {startedRow({
          ...PROGRESS,
          status: "failed",
          error: { code: "auth.required", message: "" },
        })}
      </AccessRecoveryProvider>,
      createFakeApi({}),
    );

    expect(screen.getByText("Open the link again to continue.")).toBeTruthy();
    expect(screen.queryByText(/Sign in/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open link again" }));

    await waitFor(() => expect(recovered).toEqual(["reopen"]));
  });

  test("a restored cancellation disables discard and reselection until it settles", () => {
    const entry: Extract<UploadEntry, { state: "interrupted" }> = {
      state: "interrupted",
      id: "upload_1",
      checkpoint: {
        version: 1,
        uploadId: "upload_1",
        file: { name: "a.bin", size: 8, type: "", lastModified: 1 },
      },
      cancelling: true,
      error: null,
    };

    mount(
      <UploadsProvider scope={null}>
        <InterruptedUploadRow entry={entry} />
      </UploadsProvider>,
      createFakeApi({}),
    );

    expect(screen.getByText("Cancelling…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose file" }).hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("button", { name: "Discard upload of a.bin" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  test("a failed cancel offers to cancel again, never to resume the upload", () => {
    mount(
      startedRow({
        ...PROGRESS,
        status: "failed",
        intent: "cancel",
        error: { code: "service.unavailable", message: "" },
      }),
      createFakeApi({}),
    );

    expect(screen.getByRole("button", { name: "Try cancelling again" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry upload of a.bin" })).toBeNull();
  });

  for (const intent of ["upload", undefined] as const) {
    test(`a failed upload (intent ${intent}) offers the normal retry`, () => {
      mount(
        startedRow({
          ...PROGRESS,
          status: "failed",
          intent,
          error: { code: "service.unavailable", message: "" },
        }),
        createFakeApi({}),
      );

      expect(screen.getByRole("button", { name: "Retry upload of a.bin" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Cancel upload of a.bin" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Try cancelling again" })).toBeNull();
    });
  }

  test("a discard the server rejected is shown with its real reason", () => {
    const entry: Extract<UploadEntry, { state: "interrupted" }> = {
      state: "interrupted",
      id: "upload_1",
      checkpoint: {
        version: 1,
        uploadId: "upload_1",
        file: { name: "a.bin", size: 8, type: "", lastModified: 1 },
      },
      error: { code: "service.unavailable", message: "Unavailable" },
    };

    mount(
      <UploadsProvider scope={null}>
        <InterruptedUploadRow entry={entry} />
      </UploadsProvider>,
      createFakeApi({}),
    );

    expect(screen.getByText("Your files are safe. Try again in a moment.")).toBeTruthy();
  });
});
