import type {
  AddToAlbum,
  CreateAlbum,
  PhotoSources,
  TimelineInput,
} from "#core/features/photos/api/schema";
import { PhotosService } from "#core/features/photos/service";
import type { RequestContext } from "#core/runtime";

export function photosHandlers(context: RequestContext) {
  const service = new PhotosService(context);

  return {
    "photos.sources": () => service.sources(),
    "photos.setSources": (input: typeof PhotoSources.Type) => service.setSources(input),
    "photos.timeline": (input: typeof TimelineInput.Type) => service.timeline(input),
    "photos.albums": () => service.albums(),
    "photos.createAlbum": (input: typeof CreateAlbum.Type) => service.createAlbum(input),
    "photos.addToAlbum": (input: typeof AddToAlbum.Type) => service.addToAlbum(input),
  };
}
