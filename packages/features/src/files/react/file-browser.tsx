import { FolderPlus, LayoutGrid, List, SlidersHorizontal, Upload } from "@hyori-cloud/lib/icons";
import { useRef, useState } from "@hyori-cloud/lib/react";
import type { ReactNode, RefObject } from "@hyori-cloud/lib/react";
import { Button } from "@hyori-cloud/ui/components/button";
import { DropZone, FilePicker } from "@hyori-cloud/ui/components/file-picker";
import type { FilePickerHandle } from "@hyori-cloud/ui/components/file-picker";
import {
  BreadcrumbCurrent,
  BreadcrumbLink,
  Breadcrumbs,
} from "@hyori-cloud/ui/components/breadcrumbs";
import {
  PageBar,
  PageBarActions,
  PageBody,
  PageSection,
} from "@hyori-cloud/ui/components/app-shell";
import { Notice } from "@hyori-cloud/ui/components/notice";
import { SearchField } from "@hyori-cloud/ui/components/search-field";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@hyori-cloud/ui/components/segmented-control";
import { InlineText, Row } from "@hyori-cloud/ui/components/text";
import { useDocumentKeydown } from "@hyori-cloud/ui/hooks/use-document-keydown";
import { useItemLayout } from "@hyori-cloud/ui/hooks/use-item-layout";
import { useSingleKeyShortcuts } from "@hyori-cloud/ui/hooks/use-single-key-shortcuts";
import { useBrowserPreferencesReady } from "@hyori-cloud/ui/hooks/use-browser-preferences-ready";
import { isAppShortcut } from "@hyori-cloud/ui/lib/browser";
import { useCloudNavigation } from "#features/cloud/react/cloud-navigation.tsx";
import {
  AvailableEditorsContext,
  useAvailableEditors,
} from "#features/editors/react/use-available-editors.ts";
import {
  countBarFilters,
  hasActiveFilters,
  NO_FILTERS,
  toListFilesInput,
} from "#features/files/file-filters.ts";
import type { FileFilters, FileView } from "#features/files/file-filters.ts";
import {
  FileActionsProvider,
  useFileActionFailure,
  useFileActions,
} from "#features/files/react/file-actions.tsx";
import { FileFilterBar } from "#features/files/react/file-filter-bar.tsx";
import { FileListingView } from "#features/files/react/file-listing-view.tsx";
import { FileSortControl } from "#features/files/react/file-sort-control.tsx";
import { useFileSort } from "#features/files/react/file-sort.ts";
import { FolderPathProvider } from "#features/files/react/folder-path.tsx";
import { useFileListing } from "#features/files/react/use-file-listing.ts";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import {
  AccessRecoveryButton,
  useAccessRecovery,
} from "#features/shared/react/access-recovery.tsx";
import { useUploadQueue } from "#features/uploads/react/uploads-provider.tsx";

type FileBrowserProps = {
  parentId: string | null;
  view: FileView;
  rootLabel: string;
  /** What a search covers at the root. Inside a folder, search covers only that folder. */
  rootSearchScope: string;
  /** The folder that acts as the root, for a public link scoped to one shared folder. */
  rootFolderId?: string | null;
  /** The root crumb for folders owned by someone else, reached through a share. */
  foreignRoot?: { readonly label: string; readonly path: string };
  /** Whether new items can be created at the root, which has no folder entry to carry access. */
  rootCanUpload: boolean;
  /** Muted context beside the location, such as the access a public link grants. Hidden on phones. */
  titleMeta?: ReactNode;
  actions?: ReactNode;
  folderPath: (folderId: string | null) => string;
  empty: (actions: { upload?: () => void; createFolder?: () => void }) => ReactNode;
};

function useBrowserFilters(parentId: string | null) {
  const [stored, setStored] = useState({ parentId, filters: NO_FILTERS });
  // Derived so entering another folder starts unfiltered without synchronizing state.
  const filters = stored.parentId === parentId ? stored.filters : NO_FILTERS;

  return {
    filters,
    patch: (next: Partial<FileFilters>) =>
      setStored({ parentId, filters: { ...filters, ...next } }),
    clear: () => setStored({ parentId, filters: NO_FILTERS }),
  };
}

export function FileBrowser({
  parentId,
  view,
  rootLabel,
  rootSearchScope,
  rootFolderId = null,
  foreignRoot,
  rootCanUpload,
  titleMeta,
  actions,
  folderPath,
  empty,
}: FileBrowserProps) {
  // Resolve the default open action alongside the listing, not after its rows arrive.
  const editors = useAvailableEditors();
  const [layout, setLayout] = useItemLayout();
  const [sort, setSort] = useFileSort();
  const ready = useBrowserPreferencesReady();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const { filters, patch, clear } = useBrowserFilters(parentId);

  // Changing filters keeps this folder on screen. Entering another folder never shows this one's data.
  const listing = useFileListing(
    { ...toListFilesInput(parentId, view, filters), sort },
    `${view}:${parentId}:${sort}`,
  );

  const queue = useUploadQueue();
  const picker = useRef<FilePickerHandle>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const shortcutsEnabled = useSingleKeyShortcuts();

  const firstPage = listing.data?.pages[0];
  const folder = firstPage?.folder ?? null;
  const crumbs = firstPage?.breadcrumbs ?? [];
  const entries = listing.data?.pages.flatMap((page) => page.items) ?? [];
  const canCreate = folder === null ? parentId === null && rootCanUpload : folder.access.canUpload;
  const title = crumbs.at(-1)?.name ?? (parentId === null ? rootLabel : "");
  const filtering = hasActiveFilters(filters);
  const searchScope = parentId === null ? rootSearchScope : "this folder";

  function addFiles(files: File[]) {
    queue.add(files, parentId);
  }

  return (
    <AvailableEditorsContext value={editors}>
      <FolderPathProvider value={folderPath}>
        <FileActionsProvider entries={entries} folderId={parentId}>
          <FilePicker ref={picker} onFiles={addFiles} />
          <BrowserShortcuts canCreate={canCreate} picker={picker} searchInput={searchInput} />
          <PageBar data-browser-ready={ready}>
            <BrowserLocation
              root={
                folder !== null && !folder.access.isOwner && foreignRoot
                  ? foreignRoot
                  : { label: rootLabel, path: folderPath(rootFolderId) }
              }
              showRoot={parentId !== rootFolderId}
              title={title}
              ancestors={crumbs.slice(0, -1).filter((crumb) => crumb.id !== rootFolderId)}
              folderPath={folderPath}
            />
            {titleMeta === undefined ? null : (
              <div className="hidden min-w-0 self-center truncate text-[13px] text-muted-foreground md:block">
                {titleMeta}
              </div>
            )}
            <PageBarActions className="order-last w-full md:order-none md:ml-0 md:w-auto">
              <SearchField
                key={parentId}
                inputRef={searchInput}
                className="min-w-0 flex-1 md:w-56 md:flex-none"
                label={`Search ${searchScope} by name`}
                placeholder={`Search ${searchScope}`}
                shortcut={shortcutsEnabled ? "/" : undefined}
                value={filters.search}
                onCommit={(search) => patch({ search })}
              />
              <FiltersToggle
                activeCount={countBarFilters(filters)}
                open={filtersOpen}
                onToggle={() => setFiltersOpen(!filtersOpen)}
              />
              <FileSortControl value={sort} onChange={setSort} />
            </PageBarActions>
            <PageBarActions className="md:ml-0">
              <SegmentedControl label="Layout" value={layout} onValueChange={setLayout}>
                <SegmentedControlItem value="list" label="List">
                  <List aria-hidden />
                </SegmentedControlItem>
                <SegmentedControlItem value="grid" label="Grid">
                  <LayoutGrid aria-hidden />
                </SegmentedControlItem>
              </SegmentedControl>
              {canCreate ? <CreateFolderButton /> : null}
              {canCreate ? (
                <Button onClick={() => picker.current?.open()}>
                  <Upload aria-hidden />
                  Upload
                </Button>
              ) : null}
              {actions}
            </PageBarActions>
          </PageBar>
          {filtersOpen ? (
            <FileFilterBar filters={filters} onChange={patch} onClear={clear} />
          ) : null}
          <DropZone disabled={!canCreate} label={`Drop to upload to ${title}`} onFiles={addFiles}>
            {/* Keyed so entering a folder starts at its top instead of the last one's scroll offset. */}
            <PageBody key={parentId} data-browser-ready={ready}>
              <PageSection>
                <ActionFailureNotice />
                <FileListingView
                  listing={listing}
                  layout={layout}
                  label={title}
                  filtering={filtering}
                  onClearFilters={clear}
                  empty={
                    <BrowserEmpty
                      empty={empty}
                      canCreate={canCreate}
                      onUpload={() => picker.current?.open()}
                    />
                  }
                />
              </PageSection>
            </PageBody>
          </DropZone>
        </FileActionsProvider>
      </FolderPathProvider>
    </AvailableEditorsContext>
  );
}

function FiltersToggle({
  activeCount,
  open,
  onToggle,
}: {
  activeCount: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label={activeCount === 0 ? "Filters" : `Filters, ${activeCount} active`}
      aria-expanded={open}
      className={
        activeCount === 0
          ? undefined
          : "relative after:absolute after:top-1 after:right-1 after:size-1.5 after:rounded-full after:bg-brand"
      }
      onClick={onToggle}
    >
      <SlidersHorizontal />
    </Button>
  );
}

function BrowserLocation({
  root,
  title,
  ancestors,
  showRoot,
  folderPath,
}: {
  root: { readonly label: string; readonly path: string };
  title: string;
  ancestors: readonly { readonly id: string; readonly name: string }[];
  showRoot: boolean;
  folderPath: (folderId: string | null) => string;
}) {
  const { navigatePath } = useCloudNavigation();

  return (
    <Breadcrumbs>
      {showRoot ? (
        <BreadcrumbLink href={root.path} onNavigate={navigatePath}>
          {root.label}
        </BreadcrumbLink>
      ) : null}
      {ancestors.map((crumb) => (
        <BreadcrumbLink key={crumb.id} href={folderPath(crumb.id)} onNavigate={navigatePath}>
          {crumb.name}
        </BreadcrumbLink>
      ))}
      <BreadcrumbCurrent>{title}</BreadcrumbCurrent>
    </Breadcrumbs>
  );
}

function CreateFolderButton() {
  const { openDialog } = useFileActions();

  return (
    <Button
      variant="outline"
      aria-label="New folder"
      className="max-md:size-8 max-md:px-0 max-md:coarse:size-11"
      onClick={() => openDialog({ kind: "createFolder" })}
    >
      <FolderPlus aria-hidden />
      <NewFolderLabel />
    </Button>
  );
}

function NewFolderLabel() {
  return <InlineText className="hidden font-medium md:inline">New folder</InlineText>;
}

function BrowserEmpty({
  empty,
  canCreate,
  onUpload,
}: {
  empty: FileBrowserProps["empty"];
  canCreate: boolean;
  onUpload: () => void;
}) {
  const { openDialog } = useFileActions();

  if (!canCreate) return empty({});

  return empty({ upload: onUpload, createFolder: () => openDialog({ kind: "createFolder" }) });
}

function ActionFailureNotice() {
  const { error, dismiss, recovered } = useFileActionFailure();
  const recovery = useAccessRecovery(error);

  if (error === null) return null;
  const copy = recovery ?? describeCloudError(error);

  return (
    <Notice
      title={copy.title}
      action={
        <Row className="gap-1">
          {recovery === null ? null : (
            <AccessRecoveryButton recovery={recovery} size="sm" onRecovered={recovered} />
          )}
          <Button size="sm" variant="ghost" onClick={dismiss}>
            Dismiss
          </Button>
        </Row>
      }
    >
      {copy.detail}
    </Notice>
  );
}

function BrowserShortcuts({
  canCreate,
  picker,
  searchInput,
}: {
  canCreate: boolean;
  picker: RefObject<FilePickerHandle | null>;
  searchInput: RefObject<HTMLInputElement | null>;
}) {
  const { openDialog } = useFileActions();

  useDocumentKeydown((event) => {
    if (!isAppShortcut(event)) return;

    if (event.key === "/") {
      event.preventDefault();
      searchInput.current?.focus();
    }

    if (canCreate && event.key === "n") {
      event.preventDefault();
      openDialog({ kind: "createFolder" });
    }

    if (canCreate && event.key === "u") {
      event.preventDefault();
      picker.current?.open();
    }
  });

  return null;
}
