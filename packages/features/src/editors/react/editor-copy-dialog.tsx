import type { EditorDocument, EditorSession } from "@hyori-cloud/client-sdk";
import { useId, useState } from "@hyori-cloud/lib/react";
import { Button } from "@hyori-cloud/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@hyori-cloud/ui/components/dialog";
import { Field, Form } from "@hyori-cloud/ui/components/field";
import { Input } from "@hyori-cloud/ui/components/input";
import { Label } from "@hyori-cloud/ui/components/label";
import { Text } from "@hyori-cloud/ui/components/text";
import { formText } from "#features/shared/form-values.ts";

/** The copy's name until someone changes it: the source's, in the editor's own document format. */
export function suggestedName(document: EditorDocument) {
  const extension = document.outputFormats.find((format) => format.kind === "document")?.extension;
  const dot = document.name.lastIndexOf(".");
  const stem = dot > 0 ? document.name.slice(0, dot) : document.name;

  return extension === undefined ? document.name : `${stem} copy${extension}`;
}

/** Naming a copy is explicit. The existing SDK binding asks for its destination after capture. */
export function EditorCopyDialog({
  document,
  open,
  onOpenChange,
  requestSave,
}: {
  document: EditorDocument;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestSave: EditorSession["requestSave"];
}) {
  const id = useId();
  const [declined, setDeclined] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) setDeclined(false);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save a copy</DialogTitle>
          <DialogDescription>
            The original stays unchanged. Choose where to save the copy next.
          </DialogDescription>
        </DialogHeader>
        <Form
          className="gap-0"
          onValues={(values) => {
            if (requestSave({ saveAs: true, name: formText(values, "copy-name").trim() }))
              onOpenChange(false);
            else setDeclined(true);
          }}
        >
          <DialogBody>
            <Field>
              <Label htmlFor={id}>Copy name</Label>
              <Input
                id={id}
                name="copy-name"
                required
                maxLength={255}
                defaultValue={suggestedName(document)}
                autoComplete="off"
              />
              <Text tone="muted" size="xs">
                Available formats:{" "}
                {document.outputFormats.map((format) => format.extension).join(", ")}
              </Text>
            </Field>
            {declined ? (
              <Text role="alert" tone="destructive">
                The editor can’t prepare this copy right now. Check the name, or finish the pending
                save and try again.
              </Text>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" type="button" />}>Cancel</DialogClose>
            <Button type="submit">Continue</Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
