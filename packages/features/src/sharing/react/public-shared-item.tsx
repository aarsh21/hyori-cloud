import type { FileEntry } from "@hyori-cloud/client-sdk";
import { Download, FolderOpen } from "@hyori-cloud/lib/icons";
import { AppMain, AppShell } from "@hyori-cloud/ui/components/app-shell";
import { AppearanceMenu } from "@hyori-cloud/ui/components/appearance-menu";
import { Button } from "@hyori-cloud/ui/components/button";
import { FocusLayout, FocusLayoutHeader } from "@hyori-cloud/ui/components/focus-layout";
import { RegionState } from "@hyori-cloud/ui/components/region-state";
import { Heading, Text } from "@hyori-cloud/ui/components/text";
import { Wordmark } from "@hyori-cloud/ui/components/wordmark";
import { formatCloudPath } from "#features/cloud/cloud-path.ts";
import { FileBrowser } from "#features/files/react/file-browser.tsx";
import { useDownloadFile } from "#features/files/react/use-download-file.ts";
import { formatBytes } from "#features/shared/format.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";
import { UploadTray } from "#features/uploads/react/upload-tray.tsx";

export function PublicSharedItem({
  token,
  folderId,
  item,
}: {
  token: string;
  folderId: string | null;
  item: FileEntry;
}) {
  if (item.kind === "file") return <PublicSharedFile item={item} />;

  return (
    <AppShell className="md:p-2">
      <AppMain className="md:m-0">
        <FileBrowser
          parentId={folderId ?? item.id}
          view="files"
          rootLabel={item.name}
          rootSearchScope="this folder"
          rootFolderId={item.id}
          rootCanUpload={false}
          actions={<AppearanceMenu />}
          folderPath={(id) =>
            formatCloudPath({
              section: "publicShare",
              token,
              folderId: id === item.id ? null : id,
            })
          }
          empty={() => <RegionState icon={<FolderOpen />} title="This folder is empty" />}
        />
      </AppMain>
      <UploadTray />
    </AppShell>
  );
}

function PublicSharedFile({ item }: { item: FileEntry }) {
  const download = useDownloadFile();

  return (
    <FocusLayout footer={<AppearanceMenu />}>
      <Wordmark />
      <FocusLayoutHeader>
        <Heading className="break-words">{item.name}</Heading>
        <Text tone="muted" numeric>
          {formatBytes(item.size)}
        </Text>
      </FocusLayoutHeader>
      <MutationFailure error={download.error} onRecovered={() => download.reset()} />
      {item.access.canDownload ? (
        <Button
          size="lg"
          pending={download.isPending}
          pendingLabel="Preparing…"
          onClick={() => download.mutate({ id: item.id })}
        >
          <Download aria-hidden />
          Download
        </Button>
      ) : null}
    </FocusLayout>
  );
}
