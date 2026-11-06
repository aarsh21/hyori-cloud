import type { UploadIntent } from "@hyori-cloud/client-sdk";
import { Tag } from "@hyori-cloud/ui/components/tag";

/** Says what a transfer is for. A legacy checkpoint never recorded that, so nothing is claimed. */
export function UploadIntentTag({ intent }: { intent: UploadIntent }) {
  switch (intent.kind) {
    case "replacement":
      return <Tag>New version</Tag>;
    case "new":
    case "legacy":
      return null;
  }

  intent satisfies never;

  return null;
}
