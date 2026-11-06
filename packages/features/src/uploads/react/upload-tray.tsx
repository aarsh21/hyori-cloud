import type { UploadEntry, UploadSummary } from "@hyori-cloud/client-sdk";
import { useUploadEntries, useUploadSummary } from "@hyori-cloud/client-sdk/react";
import { ChevronDown, ChevronLeft } from "@hyori-cloud/lib/icons";
import { useState } from "@hyori-cloud/lib/react";
import { Button } from "@hyori-cloud/ui/components/button";
import {
  TransferList,
  TransferTray,
  TransferTrayHeader,
  TransferTrayTitle,
} from "@hyori-cloud/ui/components/transfer-tray";
import { InterruptedUploadRow } from "#features/uploads/react/interrupted-upload-row.tsx";
import { StartedUploadRow } from "#features/uploads/react/started-upload-row.tsx";
import { useUploadQueue } from "#features/uploads/react/uploads-provider.tsx";
import { WaitingUploadRow } from "#features/uploads/react/waiting-upload-row.tsx";

function summaryTitle({ total, active, failed, complete }: UploadSummary) {
  if (active > 0) return `Uploading ${active} ${active === 1 ? "file" : "files"}`;

  if (failed > 0) return `${failed} ${failed === 1 ? "upload needs" : "uploads need"} attention`;

  if (complete === total) return `${complete} ${complete === 1 ? "upload" : "uploads"} complete`;

  return "Uploads";
}

/** Only rows subscribe to their task's progress, so one transfer never rerenders the tray. */
export function UploadTray() {
  const queue = useUploadQueue();
  const entries = useUploadEntries(queue);
  const summary = useUploadSummary(queue);
  const [collapsed, setCollapsed] = useState(false);

  if (entries.length === 0) return null;

  return (
    <TransferTray aria-label="Uploads">
      <TransferTrayHeader>
        <TransferTrayTitle>{summaryTitle(summary)}</TransferTrayTitle>
        {summary.active === 0 && summary.complete > 0 ? (
          <Button size="xs" variant="ghost" onClick={queue.clearFinished}>
            Clear
          </Button>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={collapsed ? "Show uploads" : "Hide uploads"}
          aria-expanded={!collapsed}
          // The open tray shows for itself, so its toggle doesn't stay filled like an open menu.
          className="not-hover:aria-expanded:bg-transparent not-hover:aria-expanded:text-muted-foreground"
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <ChevronLeft className="rotate-90" /> : <ChevronDown />}
        </Button>
      </TransferTrayHeader>
      {collapsed ? null : (
        <TransferList>
          {entries.map((entry) => (
            <UploadRow key={entry.id} entry={entry} />
          ))}
        </TransferList>
      )}
    </TransferTray>
  );
}

function UploadRow({ entry }: { entry: UploadEntry }) {
  switch (entry.state) {
    case "waiting":
      return <WaitingUploadRow id={entry.id} intent={entry.intent} />;
    case "started":
      return <StartedUploadRow id={entry.id} task={entry.task} retryQueued={entry.retryQueued} />;
    case "interrupted":
      return <InterruptedUploadRow entry={entry} />;
  }

  entry satisfies never;

  return null;
}
