import { ArrowLeft } from "@hyori-cloud/lib/icons";
import { Button } from "@hyori-cloud/ui/components/button";
import { InlineText, Row } from "@hyori-cloud/ui/components/text";

export function FolderPickerHeader({
  title,
  canGoBack,
  onBack,
}: {
  title: string;
  canGoBack: boolean;
  onBack: () => void;
}) {
  return (
    <Row className="min-h-7 gap-1.5">
      {canGoBack ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Up one folder"
          onClick={onBack}
        >
          <ArrowLeft />
        </Button>
      ) : null}
      <InlineText truncate className="font-medium">
        {title}
      </InlineText>
    </Row>
  );
}
