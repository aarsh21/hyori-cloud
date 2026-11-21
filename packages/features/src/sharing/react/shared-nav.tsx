import { SegmentedNav, SegmentedNavLink } from "@hyori-cloud/ui/components/segmented-control";
import { formatCloudPath } from "#features/cloud/cloud-path.ts";
import { useCloudNavigation } from "#features/cloud/react/cloud-navigation.tsx";
import { preloadCloudLocation } from "#features/cloud/react/cloud-screen-loaders.ts";

/** Shared has two sides: what people gave you, and what you gave them. Each is its own address. */
export function SharedNav() {
  const { location, navigatePath } = useCloudNavigation();

  return (
    <SegmentedNav aria-label="Shared">
      <SegmentedNavLink
        href={formatCloudPath({ section: "shared" })}
        onNavigate={navigatePath}
        onPointerEnter={() => preloadCloudLocation({ section: "shared" })}
        current={location.section === "shared"}
      >
        With me
      </SegmentedNavLink>
      <SegmentedNavLink
        href={formatCloudPath({ section: "sharedByMe" })}
        onNavigate={navigatePath}
        onPointerEnter={() => preloadCloudLocation({ section: "sharedByMe" })}
        current={location.section === "sharedByMe"}
      >
        By me
      </SegmentedNavLink>
    </SegmentedNav>
  );
}
