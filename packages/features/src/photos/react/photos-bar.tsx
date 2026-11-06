import type { ReactNode } from "@hyori-cloud/lib/react";
import { PageBar, PageBarActions, PageTitle } from "@hyori-cloud/ui/components/app-shell";
import { SegmentedNav, SegmentedNavLink } from "@hyori-cloud/ui/components/segmented-control";
import { Text } from "@hyori-cloud/ui/components/text";
import { formatCloudPath } from "#features/cloud/cloud-path.ts";
import { useCloudNavigation } from "#features/cloud/react/cloud-navigation.tsx";

export function PhotosBar({
  actions,
  status,
}: {
  actions?: ReactNode;
  /** A short state of what's on screen. Not announced: it can change on every refresh. */
  status?: string | null;
}) {
  const { location, navigatePath } = useCloudNavigation();

  return (
    <PageBar>
      <PageTitle className="sr-only">Photos</PageTitle>
      <SegmentedNav aria-label="Photos">
        <SegmentedNavLink
          href={formatCloudPath({ section: "photos" })}
          onNavigate={navigatePath}
          current={location.section === "photos"}
        >
          Timeline
        </SegmentedNavLink>
        <SegmentedNavLink
          href={formatCloudPath({ section: "albums" })}
          onNavigate={navigatePath}
          current={location.section === "albums" || location.section === "album"}
        >
          Albums
        </SegmentedNavLink>
      </SegmentedNav>
      {status ? (
        <Text size="xs" tone="muted" className="order-last w-full px-1 md:order-none md:w-auto">
          {status}
        </Text>
      ) : null}
      {actions === undefined ? null : <PageBarActions>{actions}</PageBarActions>}
    </PageBar>
  );
}
