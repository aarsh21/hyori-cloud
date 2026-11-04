import { AppearanceMenu } from "@hyori-cloud/ui/components/appearance-menu";
import { Toaster } from "@hyori-cloud/ui/components/sonner";
import { AppearanceProvider } from "@hyori-cloud/ui/theme";

export function AppearanceSurface() {
  return (
    <AppearanceProvider>
      <AppearanceMenu />
      <Toaster richColors />
    </AppearanceProvider>
  );
}
