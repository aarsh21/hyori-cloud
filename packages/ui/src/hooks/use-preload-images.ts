import { useEffect } from "react";

type DataSavingNavigator = Navigator & { readonly connection?: { readonly saveData?: boolean } };

function prefersDataSaving(host: DataSavingNavigator) {
  return host.connection?.saveData === true;
}

/**
 * Host adapter. Fetches images the viewer is about to need into the browser's own cache, and cancels
 * whatever hasn't finished once they stop being next. Skipped entirely when the browser asks to save
 * data. Registered as a host adapter so portable features can state only which URLs are next.
 */
export function usePreloadImages(urls: readonly string[]) {
  const key = urls.join("\n");

  useEffect(() => {
    if (key === "" || prefersDataSaving(navigator)) return undefined;

    const images = key.split("\n").map((url) => {
      const image = new Image();

      image.decoding = "async";
      image.src = url;

      return image;
    });

    return () => {
      for (const image of images) image.src = "";
    };
  }, [key]);
}
