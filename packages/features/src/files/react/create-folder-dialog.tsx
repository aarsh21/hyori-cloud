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
import { useCreateFolder } from "#features/files/react/use-file-mutations.ts";
import { formText } from "#features/shared/form-values.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";

export function CreateFolderDialog({
  parentId,
  open,
  onOpenChange,
}: {
  parentId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createFolder = useCreateFolder();

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) createFolder.reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
        </DialogHeader>
        <Form
          className="gap-0"
          onValues={(values) =>
            createFolder.mutate(
              { parentId, name: formText(values, "name").trim() },
              { onSuccess: () => onOpenChange(false) },
            )
          }
        >
          <DialogBody>
            <Field>
              <Label htmlFor="folder-name">Name</Label>
              <Input id="folder-name" name="name" required maxLength={255} autoComplete="off" />
            </Field>
            <MutationFailure error={createFolder.error} />
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" type="button" />}>Cancel</DialogClose>
            <Button type="submit" pending={createFolder.isPending} pendingLabel="Creating…">
              Create
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
