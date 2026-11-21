"use client";

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useAppearance } from "@hyori-cloud/ui/theme";
import { Toaster as Sonner, toast, type ToasterProps } from "sonner";

// Custom properties are outside CSSProperties' named keys, so the template index types them.
const TOAST_VARIABLES: React.CSSProperties & Record<`--${string}`, string> = {
  "--normal-bg": "var(--popover)",
  "--normal-text": "var(--popover-foreground)",
  "--normal-border": "var(--border)",
  "--border-radius": "var(--radius)",
};

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolved } = useAppearance();

  return (
    <Sonner
      theme={resolved ?? "light"}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin [animation-duration:700ms]" />,
      }}
      style={TOAST_VARIABLES}
      // Toasts clear the phone navigation instead of covering it.
      mobileOffset={{ bottom: "calc(4.25rem + env(safe-area-inset-bottom))" }}
      toastOptions={{
        classNames: {
          toast: "cn-toast",
          title: "wrap-anywhere",
          description: "wrap-anywhere",
          success: "[&_[data-icon]]:text-success",
          warning: "[&_[data-icon]]:text-warning",
          error: "[&_[data-icon]]:text-destructive",
          // Sonner's own button rules are more specific than a utility class.
          actionButton: "coarse:h-11! coarse:px-3!",
          cancelButton: "coarse:h-11! coarse:px-3!",
        },
      }}
      {...props}
    />
  );
};

export { Toaster, toast };
