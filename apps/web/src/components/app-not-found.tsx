import { buttonVariants } from "@hyori-cloud/ui/components/button";
import { FocusLayout, FocusLayoutHeader } from "@hyori-cloud/ui/components/focus-layout";
import { Heading, Text } from "@hyori-cloud/ui/components/text";
import { Wordmark } from "@hyori-cloud/ui/components/wordmark";
import { Link } from "@tanstack/react-router";

export default function AppNotFound() {
  return (
    <FocusLayout>
      <Wordmark />
      <FocusLayoutHeader>
        <Heading>This page doesn’t exist</Heading>
        <Text tone="muted">The link may be out of date.</Text>
      </FocusLayoutHeader>
      <Link to="/" className={buttonVariants({ size: "lg" })}>
        Go to Files
      </Link>
    </FocusLayout>
  );
}
