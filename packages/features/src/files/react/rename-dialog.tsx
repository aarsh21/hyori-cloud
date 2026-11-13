import type { FileEntry } from "@hyori-cloud/client-sdk";
import { Button } from "@hyori-cloud/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@hyori-cloud/ui/components/dialog";
import { Field, Form } from "@hyori-cloud/ui/components/field";
import { Input } from "@hyori-cloud/ui/components/input";
import { Label } from "@hyori-cloud/ui/components/label";
import { useRenameFile } from "#features/files/react/use-file-mutations.ts";
import { formText } from "#features/shared/form-values.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";

export function RenameDialog({
  entry,
  open,
  onOpenChange,
}: {
  entry: FileEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rename = useRenameFile();

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) rename.reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename</DialogTitle>
        </DialogHeader>
        <Form
          className="gap-0"
          onValues={(values) => {
            const name = formText(values, "name").trim();

            if (name === entry.name) onOpenChange(false);
            else
              rename.mutate(
                { id: entry.id, name, expectedName: entry.name },
                { onSuccess: () => onOpenChange(false) },
              );
          }}
        >
          <DialogBody>
            <Field>
              <Label htmlFor="rename-name">Name</Label>
              <Input
                id="rename-name"
                name="name"
                defaultValue={entry.name}
                required
                maxLength={255}
                autoComplete="off"
                onFocus={(event) => {
                  // Select the stem so the extension survives typing a new name.
                  const dot = event.target.value.lastIndexOf(".");
                  const end = entry.kind === "file" && dot > 0 ? dot : event.target.value.length;
                  event.target.setSelectionRange(0, end);
                }}
              />
            </Field>
            <MutationFailure error={rename.error} />
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" type="button" />}>Cancel</DialogClose>
            <Button type="submit" pending={rename.isPending} pendingLabel="Renaming…">
              Rename
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
