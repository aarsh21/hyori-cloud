import { Button } from "@hyori-cloud/ui/components/button";
import { FocusLayout, FocusLayoutHeader } from "@hyori-cloud/ui/components/focus-layout";
import { Heading, Text } from "@hyori-cloud/ui/components/text";
import { Wordmark } from "@hyori-cloud/ui/components/wordmark";

/** Most often a screen's code that didn't arrive, such as after a new version was deployed. */
export default function AppError() {
  return (
    <FocusLayout>
      <Wordmark />
      <FocusLayoutHeader>
        <Heading>Hyori couldn’t finish loading</Heading>
        <Text tone="muted">Your files aren’t affected. Reloading gets the latest version.</Text>
      </FocusLayoutHeader>
      <Button size="lg" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </FocusLayout>
  );
}
