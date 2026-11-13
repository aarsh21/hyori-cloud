import { PageBar, PageBody, PageSection } from "@hyori-cloud/ui/components/app-shell";
import { ItemGridSkeleton, ItemTableSkeleton } from "@hyori-cloud/ui/components/item-collection";
import { MediaGridSkeleton } from "@hyori-cloud/ui/components/media-grid";
import type { CloudLocation } from "#features/cloud/cloud-path.ts";

type ShellLocation = Exclude<
  CloudLocation,
  { section: "invite" | "passwordReset" | "publicShare" | "publicEditor" | "editor" }
>;

function FallbackFrame({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageBar aria-hidden />
      <PageBody>
        <PageSection>{children}</PageSection>
      </PageBody>
    </>
  );
}

/** Shown only while a screen's code arrives, in the shape that screen will take. */
export function CloudScreenFallback({ location }: { location: ShellLocation }) {
  switch (location.section) {
    case "files":
    case "notes":
    case "shared":
    case "trash":
    case "admin":
      return (
        <FallbackFrame>
          <ItemTableSkeleton />
        </FallbackFrame>
      );
    case "photos":
    case "album":
      return (
        <FallbackFrame>
          <MediaGridSkeleton />
        </FallbackFrame>
      );
    case "albums":
      return (
        <FallbackFrame>
          <ItemGridSkeleton tiles={6} />
        </FallbackFrame>
      );
    case "notFound":
      return null;
  }

  location satisfies never;

  return null;
}
