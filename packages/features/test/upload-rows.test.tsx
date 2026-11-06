import { describe, expect } from "bun:test";
import type {
  UploadEntry,
  UploadIntent,
  UploadSnapshot,
  UploadTask,
} from "@hyori-cloud/client-sdk";
import { AccessRecoveryProvider } from "#features/shared/react/access-recovery.tsx";
import { InterruptedUploadRow } from "#features/uploads/react/interrupted-upload-row.tsx";
import { StartedUploadRow } from "#features/uploads/react/started-upload-row.tsx";
import { UploadsProvider } from "#features/uploads/react/uploads-provider.tsx";
import { WaitingUploadRow } from "#features/uploads/react/waiting-upload-row.tsx";
import { createFakeApi, fireEvent, mount, screen, test, waitFor } from "#features-test/mounted.tsx";

const NEW_FILE: UploadIntent = { kind: "new", name: "a.bin" };
const NEW_VERSION: UploadIntent = { kind: "replacement", name: "report.pdf", targetId: "file_1" };

function taskIn(snapshot: UploadSnapshot, intent: UploadIntent) {
  const task: UploadTask = {
    intent,
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

function startedRow(snapshot: UploadSnapshot, intent = NEW_FILE, retryQueued = false) {
  return (
    <UploadsProvider scope={null}>
      <StartedUploadRow id="upload_1" task={taskIn(snapshot, intent)} retryQueued={retryQueued} />
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

  test("an uploading row can be paused, and a paused one resumed", () => {
    const { rerender } = mount(startedRow({ ...PROGRESS, status: "uploading" }), createFakeApi({}));
    const pause = screen.getByRole("button", { name: "Pause upload of a.bin" });

    expect(pause.hasAttribute("disabled")).toBe(false);
    rerender(startedRow({ ...PROGRESS, status: "paused" }));

    expect(screen.getByRole("button", { name: "Resume upload of a.bin" })).toBeTruthy();
  });

  test("a state with nothing to pause keeps the control in place, inert", () => {
    mount(startedRow({ ...PROGRESS, status: "finalizing" }), createFakeApi({}));

    const pause = screen.getByRole("button", { name: "Pause upload of a.bin" });

    expect(pause.getAttribute("aria-busy")).toBe("true");
  });

  test("pressing Retry keeps the same control, so keyboard focus has somewhere to stay", () => {
    const failed: UploadSnapshot = {
      ...PROGRESS,
      status: "failed",
      error: { code: "service.unavailable", message: "" },
    };

    const { rerender } = mount(startedRow(failed), createFakeApi({}));
    const control = screen.getByRole("button", { name: "Retry upload of a.bin" });

    rerender(startedRow({ ...PROGRESS, status: "pending" }));

    expect(screen.getByRole("button", { name: "Pause upload of a.bin" })).toBe(control);
  });

  test("a Retry waiting for a slot keeps its control and focus, and can't be pressed again", () => {
    const failed: UploadSnapshot = {
      ...PROGRESS,
      status: "failed",
      error: { code: "service.unavailable", message: "" },
    };

    const { rerender } = mount(startedRow(failed), createFakeApi({}));
    const control = screen.getByRole("button", { name: "Retry upload of a.bin" });

    control.focus();
    rerender(startedRow(failed, NEW_FILE, true));

    const waiting = screen.getByRole("button", { name: "Retry upload of a.bin" });

    expect(waiting).toBe(control);
    expect(document.activeElement).toBe(control);
    expect(waiting.getAttribute("aria-busy")).toBe("true");
    expect(waiting.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Waiting to retry")).toBeTruthy();
  });

  test("a Retry waiting for a slot stops reading as a failure, and can still be cancelled", () => {
    const failed: UploadSnapshot = {
      ...PROGRESS,
      status: "failed",
      error: { code: "service.unavailable", message: "" },
    };

    const { rerender } = mount(startedRow(failed), createFakeApi({}));

    expect(screen.getByText("Your files are safe. Try again in a moment.")).toBeTruthy();

    rerender(startedRow(failed, NEW_FILE, true));

    expect(screen.queryByText("Your files are safe. Try again in a moment.")).toBeNull();
    expect(cancelButton().hasAttribute("disabled")).toBe(false);
  });

  test("when the queue withdraws a waiting Retry, the failure and an active Retry come back", () => {
    const failed: UploadSnapshot = {
      ...PROGRESS,
      status: "failed",
      error: { code: "service.unavailable", message: "" },
    };

    const { rerender } = mount(startedRow(failed, NEW_FILE, true), createFakeApi({}));

    rerender(startedRow(failed, NEW_FILE, false));

    const control = screen.getByRole("button", { name: "Retry upload of a.bin" });

    expect(control.getAttribute("aria-busy")).toBeNull();
    expect(screen.queryByText("Waiting to retry")).toBeNull();
  });

  test("a Resume waiting for a slot says so, and can't be pressed again", () => {
    mount(startedRow({ ...PROGRESS, status: "paused" }, NEW_FILE, true), createFakeApi({}));

    expect(screen.getByText("Waiting to resume at 50%")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Resume upload of a.bin" }).getAttribute("aria-busy"),
    ).toBe("true");
  });

  test("a failed cancel waiting for a slot says it's a cancel, and never offers to resume", () => {
    mount(
      startedRow(
        {
          ...PROGRESS,
          status: "failed",
          intent: "cancel",
          error: { code: "service.unavailable", message: "" },
        },
        NEW_FILE,
        true,
      ),
      createFakeApi({}),
    );

    expect(screen.getByText("Waiting to cancel")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Try cancelling again" }).getAttribute("aria-busy"),
    ).toBe("true");
    expect(screen.queryByRole("button", { name: /Retry upload|Resume/ })).toBeNull();
  });

  test("once recovery has queued its retry, the row waits rather than offering recovery again", () => {
    mount(
      <AccessRecoveryProvider
        value={() => ({
          title: "Your access through this link has ended",
          detail: "Open the link again to continue.",
          actionLabel: "Open link again",
          pendingLabel: "Opening…",
          pending: false,
          recover: () => {},
        })}
      >
        {startedRow(
          { ...PROGRESS, status: "failed", error: { code: "auth.required", message: "" } },
          NEW_FILE,
          true,
        )}
      </AccessRecoveryProvider>,
      createFakeApi({}),
    );

    expect(screen.getByText("Waiting to retry")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open link again" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Retry upload of a.bin" }).getAttribute("aria-busy"),
    ).toBe("true");
  });

  test("a new version is labelled in every state, under the file it replaces", () => {
    const { rerender } = mount(
      <UploadsProvider scope={null}>
        <WaitingUploadRow id="upload_1" intent={NEW_VERSION} />
      </UploadsProvider>,
      createFakeApi({}),
    );

    expect(screen.getByText("report.pdf")).toBeTruthy();
    expect(screen.getByText("New version")).toBeTruthy();

    rerender(startedRow({ ...PROGRESS, status: "uploading" }, NEW_VERSION));
    expect(screen.getByText("report.pdf")).toBeTruthy();
    expect(screen.getByText("New version")).toBeTruthy();

    rerender(
      <UploadsProvider scope={null}>
        <InterruptedUploadRow
          entry={{
            state: "interrupted",
            id: "upload_1",
            intent: NEW_VERSION,
            checkpoint: {
              version: 2,
              uploadId: "upload_1",
              intent: NEW_VERSION,
              file: { name: "edited copy.pdf", size: 8, type: "", lastModified: 1 },
            },
            error: null,
          }}
        />
      </UploadsProvider>,
    );

    expect(screen.getByText("report.pdf")).toBeTruthy();
    expect(screen.getByText("New version")).toBeTruthy();
    expect(
      screen.getByText("Interrupted. Choose “edited copy.pdf” again to continue."),
    ).toBeTruthy();
  });

  test("an ordinary upload and a legacy checkpoint claim no replacement", () => {
    const { rerender } = mount(startedRow({ ...PROGRESS, status: "uploading" }), createFakeApi({}));

    expect(screen.queryByText("New version")).toBeNull();

    rerender(startedRow({ ...PROGRESS, status: "uploading" }, { kind: "legacy", name: "a.bin" }));
    expect(screen.getByText("a.bin")).toBeTruthy();
    expect(screen.queryByText("New version")).toBeNull();
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
      intent: { kind: "legacy", name: "a.bin" },
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

  test("a cancel that hit a conflict is a failed cancel, not a conflicting upload", () => {
    mount(
      startedRow(
        {
          ...PROGRESS,
          status: "failed",
          intent: "cancel",
          error: { code: "resource.conflict", message: "Resource conflicts with existing state" },
        },
        NEW_VERSION,
      ),
      createFakeApi({}),
    );

    expect(
      screen.getByText("Couldn’t confirm the cancellation. This upload may still finish."),
    ).toBeTruthy();
    expect(screen.queryByText(/reported a conflict|couldn’t confirm the new version/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Try cancelling again" })).toBeTruthy();
  });

  test("a confirmed cancel of a new version says only that this version wasn't saved", () => {
    mount(startedRow({ ...PROGRESS, status: "cancelled" }, NEW_VERSION), createFakeApi({}));

    expect(screen.getByText("Cancelled. This new version wasn’t saved.")).toBeTruthy();
    expect(screen.queryByText(/current version/)).toBeNull();
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
      intent: { kind: "legacy", name: "a.bin" },
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

    expect(
      screen.getByText(
        "Couldn’t confirm the cancellation. Your files are safe. Try again in a moment.",
      ),
    ).toBeTruthy();
  });
});
