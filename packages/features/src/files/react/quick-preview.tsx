import type { FileEntry } from "@hyori-cloud/client-sdk";
import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { Download } from "@hyori-cloud/lib/icons";
import { useQuery } from "@hyori-cloud/lib/query";
import { useContext, useRef } from "@hyori-cloud/lib/react";
import type { ReactNode } from "@hyori-cloud/lib/react";
import { Button } from "@hyori-cloud/ui/components/button";
import { Checkbox } from "@hyori-cloud/ui/components/checkbox";
import {
  Lightbox,
  LightboxAction,
  LightboxMessage,
  LightboxNotice,
  LightboxPending,
} from "@hyori-cloud/ui/components/lightbox";
import { Spinner } from "@hyori-cloud/ui/components/spinner";
import { useFocusWhenActive } from "@hyori-cloud/ui/hooks/use-focus-when-active";
import { cn } from "@hyori-cloud/ui/lib/utils";
import { AvailableEditorsContext } from "#features/editors/react/use-available-editors.ts";
import { useOpenInEditor } from "#features/editors/react/use-open-in-editor.ts";
import { FileTypeIcon } from "#features/files/react/file-type-icon.tsx";
import { useDownloadFile } from "#features/files/react/use-download-file.ts";
import { useFileUrl } from "#features/files/react/use-file-url.ts";
import { parseCsv } from "#features/files/preview-csv.ts";
import {
  parseMarkdown,
  safeHref,
  type MarkdownBlock,
  type MarkdownInline,
  type MarkdownListItem,
} from "#features/files/preview-markdown.ts";
import {
  AccessRecoveryButton,
  useAccessRecovery,
} from "#features/shared/react/access-recovery.tsx";
import { describeCloudError, endsItemAccess } from "#features/shared/cloud-error.ts";
import type { CloudError } from "#features/shared/cloud-error.ts";
import { formatBytes, formatDateTime, isMediaType } from "#features/shared/format.ts";

const NOTE_MIME = "application/vnd.hyori.note";
const PREVIEW_TEXT_LIMIT = 1024 * 1024;
const TABLE_ROW_LIMIT = 100;

/** What a card says when the server declined to inline the file's bytes. */
const UNPREVIEWABLE = "This file can’t be previewed.";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd"]);

// Extensions whose bytes are machine values; DESIGN.md reserves the mono face for those.
const CODE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".log",
  ".rs",
  ".py",
  ".go",
  ".java",
  ".kt",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".sh",
  ".bash",
  ".sql",
  ".css",
  ".scss",
  ".lua",
  ".dart",
  ".scala",
  ".zig",
  ".gradle",
]);

const TEXT_EXTENSIONS = new Set([".txt", ".text", ...CODE_EXTENSIONS]);

/** Media has its own viewer, and Notes open as notes. Everything else previews here. */
export function isPreviewItem(entry: FileEntry): boolean {
  return entry.kind === "file" && !isMediaType(entry.mimeType) && entry.mimeType !== NOTE_MIME;
}

type PreviewKind =
  | { kind: "pdf" }
  | { kind: "table"; delimiter: string }
  | { kind: "markdown" }
  | { kind: "text"; mono: boolean }
  | { kind: "card" };

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");

  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/**
 * The app picks a pane from what the entry claims to be; the server separately refuses to serve
 * bytes that don't match, so a mislabelled file lands on an honest message, never a broken pane.
 */
function previewKind(entry: FileEntry): PreviewKind {
  const extension = fileExtension(entry.name);
  const declaredPdf = entry.mimeType === "application/pdf" || extension === ".pdf";
  const generic = entry.mimeType === "application/octet-stream";

  const textual =
    (entry.mimeType.startsWith("text/") && entry.mimeType !== "text/html") ||
    entry.mimeType === "application/json";

  if (declaredPdf) return { kind: "pdf" };

  const tabbed = entry.mimeType === "text/tab-separated-values" || extension === ".tsv";

  if (
    tabbed ||
    entry.mimeType === "text/csv" ||
    ((generic || textual) && (extension === ".csv" || extension === ".tsv"))
  )
    return { kind: "table", delimiter: tabbed ? "\t" : "," };

  if (
    entry.mimeType === "text/markdown" ||
    ((generic || textual) && MARKDOWN_EXTENSIONS.has(extension))
  )
    return { kind: "markdown" };

  if (textual || (generic && TEXT_EXTENSIONS.has(extension)))
    return {
      kind: "text",
      mono: entry.mimeType === "application/json" || CODE_EXTENSIONS.has(extension),
    };

  return { kind: "card" };
}

/** `items` are the previewable files in view. Stepping updates only the ID the owner already holds. */
export function QuickPreview({
  items,
  itemId,
  open,
  onOpenChange,
  onSelect,
}: {
  items: readonly FileEntry[];
  itemId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
}) {
  const index = items.findIndex((item) => item.id === itemId);
  const entry = items[index];
  const previous = items[index - 1];
  const next = items[index + 1];
  const download = useDownloadFile();

  if (entry === undefined) return null;

  return (
    <Lightbox
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) download.reset();
        onOpenChange(nextOpen);
      }}
      title={entry.name}
      onPrevious={previous ? () => onSelect(previous.id) : undefined}
      onNext={next ? () => onSelect(next.id) : undefined}
      actions={
        <>
          {entry.access.canDownload ? (
            <LightboxAction
              aria-label={`Download ${entry.name}`}
              aria-busy={download.isPending}
              disabled={download.isPending}
              onClick={() => download.mutate({ id: entry.id })}
            >
              {download.isPending ? (
                <Spinner label="Preparing download" className="text-current" />
              ) : (
                <Download aria-hidden />
              )}
            </LightboxAction>
          ) : null}
        </>
      }
    >
      <PreviewPane
        key={entry.id}
        entry={entry}
        open={open}
        onDownload={() => download.mutate({ id: entry.id })}
      />
      {download.error !== null && download.variables.id === entry.id ? (
        <DownloadFailure
          error={download.error}
          onRetry={() => download.mutate({ id: entry.id })}
          onRecovered={() => download.reset()}
        />
      ) : null}
    </Lightbox>
  );
}

function DownloadFailure({
  error,
  onRetry,
  onRecovered,
}: {
  error: CloudError;
  onRetry: () => void;
  onRecovered: () => void;
}) {
  const recovery = useAccessRecovery(error);

  return (
    <LightboxNotice
      title={`Couldn’t download. ${(recovery ?? describeCloudError(error)).title}.`}
      action={
        recovery === null ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : (
          <AccessRecoveryButton recovery={recovery} size="sm" onRecovered={onRecovered} />
        )
      }
    />
  );
}

function PreviewPane({
  entry,
  open,
  onDownload,
}: {
  entry: FileEntry;
  open: boolean;
  onDownload: () => void;
}) {
  const kind = previewKind(entry);
  const url = useFileUrl(entry.id, open && kind.kind !== "card");

  const text = usePreviewText(
    url.data?.url,
    entry,
    open && kind.kind !== "pdf" && kind.kind !== "card",
  );

  // A frame cannot report that the server refused its URL, so the pdf pane asks before embedding.
  const probe = usePreviewProbe(url.data?.url, entry, open && kind.kind === "pdf");

  // A zero-byte file has nothing to fetch; the card is the whole preview.
  if (kind.kind !== "card" && entry.size <= 0)
    return <CardPane entry={entry} onDownload={onDownload} />;

  if (url.error?.code === "input.invalid")
    return <CardPane entry={entry} onDownload={onDownload} note={UNPREVIEWABLE} />;

  if (url.error !== null && endsItemAccess(url.error))
    return <PreviewFailure error={url.error} onRetry={() => url.refetch()} />;

  if (url.error !== null) return <PreviewFailure error={url.error} onRetry={() => url.refetch()} />;

  if (kind.kind === "card") return <CardPane entry={entry} onDownload={onDownload} />;

  if (url.data === undefined) return <LightboxPending />;

  if (kind.kind === "pdf") {
    if (probe.data === undefined) return <LightboxPending />;

    // Mislabeled bytes never reach the frame, so no raw error can appear inside it.
    if (probe.data === "unavailable")
      return <CardPane entry={entry} onDownload={onDownload} note={UNPREVIEWABLE} />;

    if (probe.data === "network") return <PreviewRetry onRetry={() => probe.refetch()} />;

    return (
      <PreviewSheet className="h-[85vh] max-h-full w-[min(64rem,94vw)]" scroll={false}>
        {/* No iframe sandbox attribute: Chromium's PDF viewer refuses to load in a sandboxed
            frame. The response itself is served with `CSP: sandbox; default-src 'none'`, which
            isolates the document without breaking the viewer. */}
        <iframe src={url.data.url} title={entry.name} className="h-full w-full bg-white" />
      </PreviewSheet>
    );
  }

  if (text.data === undefined) return <LightboxPending />;

  // A non-OK response means the server declined to inline this file; download is still offered.
  if (text.data.status === "unavailable")
    return <CardPane entry={entry} onDownload={onDownload} note={UNPREVIEWABLE} />;

  // A dropped connection is not an access problem; the URL query owns those failures.
  if (text.data.status === "network") return <PreviewRetry onRetry={() => text.refetch()} />;

  if (kind.kind === "table") return <TablePane entry={entry} kind={kind} text={text.data} />;

  if (kind.kind === "markdown") return <MarkdownPane text={text.data} />;

  return <TextPane mono={kind.kind === "text" && kind.mono} text={text.data.text} />;
}

function PreviewRetry({ onRetry }: { onRetry: () => void }) {
  return (
    <LightboxMessage
      title="This preview couldn’t load."
      action={
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  );
}

type PreviewText =
  | { status: "ok"; text: string; truncated: boolean }
  | { status: "unavailable" }
  | { status: "network" };

/** Fetches the first megabyte of text for a pane; a 206 means the file is longer than what shows. */
function usePreviewText(url: string | undefined, entry: FileEntry, enabled: boolean) {
  const { previews } = useClientSDK();

  return useQuery({
    queryKey: ["files", "preview-text", entry.id, entry.size, url],
    enabled: enabled && url !== undefined,
    queryFn: async (): Promise<PreviewText> => {
      try {
        const response = await previews.fetch(url!, {
          headers:
            entry.size > PREVIEW_TEXT_LIMIT ? { range: `bytes=0-${PREVIEW_TEXT_LIMIT - 1}` } : {},
        });

        if (!response.ok) return { status: "unavailable" };

        return { status: "ok", text: await response.text(), truncated: response.status === 206 };
      } catch {
        return { status: "network" };
      }
    },
  });
}

/** Asks for one byte of what a frame would embed, because a frame cannot report a refused URL
    itself: the answer says whether the server will inline these bytes before any frame loads. */
function usePreviewProbe(url: string | undefined, entry: FileEntry, enabled: boolean) {
  const { previews } = useClientSDK();

  return useQuery({
    queryKey: ["files", "preview-probe", entry.id, url],
    enabled: enabled && url !== undefined,
    queryFn: async (): Promise<"ok" | "unavailable" | "network"> => {
      try {
        const response = await previews.fetch(url!, { headers: { range: "bytes=0-0" } });

        return response.ok ? "ok" : "unavailable";
      } catch {
        return "network";
      }
    },
  });
}

function PreviewFailure({ error, onRetry }: { error: CloudError; onRetry: () => void }) {
  const recovery = useAccessRecovery(error);

  return (
    <LightboxMessage
      title={(recovery ?? describeCloudError(error)).title}
      action={
        recovery === null ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : (
          <AccessRecoveryButton recovery={recovery} size="sm" onRecovered={onRetry} />
        )
      }
    />
  );
}

/**
 * The preview's page, on the viewer's near-black stage. One sheet shape carries every kind: a
 * rounded card with a scrollable body and, when content is capped, an honest footer about it.
 */
function PreviewSheet({
  className,
  footer,
  scroll = true,
  children,
}: {
  className?: string;
  footer?: ReactNode;
  scroll?: boolean;
  children: ReactNode;
}) {
  const region = useRef<HTMLDivElement>(null);

  // Keyboard readers land in the document, not back on the rows behind the overlay.
  useFocusWhenActive(scroll, () => region.current?.focus({ preventScroll: true }));

  return (
    <div
      className={cn(
        "flex min-h-0 max-h-full w-full max-w-full flex-col overflow-hidden rounded-xl bg-card text-foreground ring-1 ring-white/15 shadow-2xl",
        className,
      )}
    >
      {scroll ? (
        <div
          ref={region}
          tabIndex={0}
          role="region"
          aria-label="Preview content"
          className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {children}
        </div>
      ) : (
        children
      )}
      {footer !== undefined ? (
        <div className="shrink-0 border-t border-border/60 px-4 py-2 text-xs text-muted-foreground">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

function TablePane({
  entry,
  kind,
  text,
}: {
  entry: FileEntry;
  kind: Extract<PreviewKind, { kind: "table" }>;
  text: { text: string; truncated: boolean };
}) {
  const table = parseCsv(text.text, kind.delimiter);
  const rows = table.rows.slice(0, TABLE_ROW_LIMIT);

  if (rows.length === 0)
    return (
      <PreviewSheet className="w-[min(40rem,92vw)]">
        <div className="grid h-40 place-items-center text-[13px] text-muted-foreground">
          No rows to show.
        </div>
      </PreviewSheet>
    );

  const beyond =
    (text.truncated ? `Showing the first 1 MB of ${formatBytes(entry.size)}` : null) ??
    (table.rowCount > rows.length
      ? `Showing the first ${rows.length} of ${table.rowCount} rows.`
      : null);

  return (
    <PreviewSheet className="h-[78vh] w-[min(56rem,94vw)]" footer={beyond ?? undefined}>
      <table className="w-full border-collapse text-[13px] tabular-nums">
        {rows.map((cells, rowIndex) => (
          <tr key={rowIndex} className={rowIndex === 0 ? "sticky top-0 z-10 bg-muted" : undefined}>
            {cells.map((cell, cellIndex) =>
              rowIndex === 0 ? (
                <th
                  key={cellIndex}
                  scope="col"
                  className="border-b border-border px-3 py-2 text-left font-medium text-muted-foreground"
                >
                  {cell}
                </th>
              ) : (
                <td key={cellIndex} className="border-b border-border/60 px-3 py-1.5 align-top">
                  {cell}
                </td>
              ),
            )}
          </tr>
        ))}
      </table>
    </PreviewSheet>
  );
}

export function MarkdownPane({ text }: { text: { text: string } }) {
  const blocks = parseMarkdown(text.text);

  if (blocks.length === 0)
    return (
      <PreviewSheet className="w-[min(40rem,92vw)]">
        <div className="grid h-40 place-items-center text-[13px] text-muted-foreground">
          This file is empty.
        </div>
      </PreviewSheet>
    );

  return (
    <PreviewSheet className="h-[80vh] w-[min(40rem,92vw)]">
      <div className="px-6 py-6 text-[15px] leading-[1.75]">
        <MarkdownBlocks blocks={blocks} />
      </div>
    </PreviewSheet>
  );
}

const MARKDOWN_HEADING_TAGS = ["h2", "h3", "h4", "h5", "h6"] as const;

function MarkdownBlocks({ blocks }: { blocks: readonly MarkdownBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.type) {
          case "heading": {
            // Level 1 maps to h2 so a document's own title never outranks app headings.
            const Heading = MARKDOWN_HEADING_TAGS[Math.min(block.level, 5) - 1]!;

            return (
              <Heading
                key={index}
                className={cn(
                  "font-semibold tracking-tight first:mt-0",
                  block.level === 1 && "mb-4 mt-8 text-[26px]",
                  block.level === 2 && "mb-3 mt-8 text-[20px]",
                  block.level === 3 && "mb-2 mt-6 text-[17px]",
                  block.level >= 4 && "mb-2 mt-5 text-[15px]",
                )}
              >
                <MarkdownInlineView inline={block.inline} />
              </Heading>
            );
          }

          case "paragraph":
            return (
              <p key={index} className="my-3 first:mt-0 last:mb-0">
                <MarkdownInlineView inline={block.inline} />
              </p>
            );
          case "code":
            return (
              <pre
                key={index}
                className="my-4 overflow-x-auto rounded-lg bg-muted p-3.5 font-mono text-[12.5px] leading-relaxed first:mt-0"
              >
                <code>{block.text}</code>
              </pre>
            );
          case "quote":
            return (
              <blockquote
                key={index}
                className="my-4 border-l-2 border-border pl-4 text-muted-foreground first:mt-0"
              >
                <MarkdownBlocks blocks={block.blocks} />
              </blockquote>
            );
          case "list":
            return <ListBlock key={index} ordered={block.ordered} items={block.items} />;
          case "table":
            return (
              <div
                key={index}
                className="my-4 overflow-x-auto rounded-lg ring-1 ring-border first:mt-0"
              >
                <table className="w-full border-collapse text-[13px]">
                  <tbody>
                    {block.rows.map((cells, rowIndex) => (
                      <tr key={rowIndex}>
                        {cells.map((cell, cellIndex) => (
                          <td
                            key={cellIndex}
                            className={cn(
                              "border-b border-border/60 px-3 py-1.5",
                              rowIndex === 0 && "bg-muted/60 font-medium",
                            )}
                          >
                            <MarkdownInlineView inline={cell} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "divider":
            return <hr key={index} className="my-6 border-border" />;
        }
      })}
    </>
  );
}

function ListBlock({ ordered, items }: { ordered: boolean; items: readonly MarkdownListItem[] }) {
  return (
    <ul className={cn("my-3 space-y-1.5 pl-6 first:mt-0", ordered ? "list-decimal" : "list-disc")}>
      {items.map((item, index) => (
        // A task item carries its own marker, so the bullet or number steps aside.
        <li key={index} className={item.task === undefined ? undefined : "list-none"}>
          {item.task === undefined ? null : (
            <Checkbox checked={item.task} disabled className="mr-2 inline-flex align-[-3px]" />
          )}
          <MarkdownInlineView inline={item.inline} />
          {item.children.length > 0 ? (
            <div className="mt-1.5">
              <MarkdownBlocks blocks={item.children} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function MarkdownInlineView({ inline }: { inline: readonly MarkdownInline[] }) {
  return (
    <>
      {inline.map((node, index) => {
        switch (node.type) {
          case "text":
            return node.text;
          case "code":
            return (
              <code
                key={index}
                className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground"
              >
                {node.text}
              </code>
            );
          case "strong":
            return (
              <strong key={index} className="font-semibold">
                <MarkdownInlineView inline={node.inline} />
              </strong>
            );
          case "emphasis":
            return (
              <em key={index}>
                <MarkdownInlineView inline={node.inline} />
              </em>
            );
          case "link": {
            const href = safeHref(node.href);

            if (href === null) return <MarkdownInlineView key={index} inline={node.inline} />;

            return (
              <a
                key={index}
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="text-foreground underline decoration-border underline-offset-[3px] hover:decoration-foreground"
              >
                <MarkdownInlineView inline={node.inline} />
              </a>
            );
          }
        }
      })}
    </>
  );
}

function TextPane({ mono, text }: { mono: boolean; text: string }) {
  return (
    <PreviewSheet className="h-[78vh] w-[min(48rem,92vw)]">
      <pre
        className={cn(
          "whitespace-pre-wrap px-6 py-6 first:mt-0",
          mono ? "font-mono text-[12.5px] leading-relaxed" : "text-[14px] leading-[1.7]",
        )}
      >
        {text}
      </pre>
    </PreviewSheet>
  );
}

function CardPane({
  entry,
  onDownload,
  note,
}: {
  entry: FileEntry;
  onDownload: () => void;
  /** Stands in for size and date when the card explains why nothing rendered. */
  note?: string;
}) {
  const editors = useContext(AvailableEditorsContext);

  if (editors === null)
    throw new Error("Quick preview requires the browser's editor capabilities.");

  const openEditor = useOpenInEditor(entry, editors);

  return (
    <PreviewSheet className="w-[min(24rem,92vw)]" scroll={false}>
      <div className="flex flex-col items-center gap-4 px-8 py-10 text-center">
        <FileTypeIcon entry={entry} />
        <div className="flex flex-col gap-1">
          <p className="break-all text-[15px] font-medium">{entry.name}</p>
          <p className="text-[13px] text-muted-foreground">
            {note ?? `${formatBytes(entry.size)} · ${formatDateTime(entry.updatedAt)}`}
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {entry.access.canDownload ? (
            <Button size="sm" onClick={onDownload}>
              <Download />
              Download
            </Button>
          ) : null}
          {openEditor !== null && openEditor !== undefined ? (
            <Button size="sm" variant="outline" onClick={openEditor}>
              Open in editor
            </Button>
          ) : null}
        </div>
      </div>
    </PreviewSheet>
  );
}
