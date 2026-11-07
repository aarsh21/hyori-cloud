import { FocusLayout } from "@hyori-cloud/ui/components/focus-layout";
import { Spinner } from "@hyori-cloud/ui/components/spinner";
import { Row } from "@hyori-cloud/ui/components/text";
import { Wordmark } from "@hyori-cloud/ui/components/wordmark";

export function FocusFallback() {
  return (
    <FocusLayout>
      <Wordmark />
      <Row className="min-h-9">
        <Spinner />
      </Row>
    </FocusLayout>
  );
}
