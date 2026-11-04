import { Rpc } from "@hyori-cloud/lib/effect/rpc";
import { ApiError, Done, Empty } from "#core/features/auth/api/schema";
import {
  AddToAlbum,
  Album,
  Albums,
  CreateAlbum,
  PhotoSources,
  Timeline,
  TimelineInput,
} from "#core/features/photos/api/schema";

export const photosOperations = [
  {
    rpc: Rpc.make("photos.sources", { payload: Empty, success: PhotoSources, error: ApiError }),
    kind: "query",
  },
  {
    rpc: Rpc.make("photos.setSources", {
      payload: PhotoSources,
      success: PhotoSources,
      error: ApiError,
    }),
    kind: "mutation",
    invalidates: ["photos"],
  },
  {
    rpc: Rpc.make("photos.timeline", {
      payload: TimelineInput,
      success: Timeline,
      error: ApiError,
    }),
    kind: "query",
  },
  {
    rpc: Rpc.make("photos.albums", { payload: Empty, success: Albums, error: ApiError }),
    kind: "query",
  },
  {
    rpc: Rpc.make("photos.createAlbum", { payload: CreateAlbum, success: Album, error: ApiError }),
    kind: "mutation",
    invalidates: ["photos"],
  },
  {
    rpc: Rpc.make("photos.addToAlbum", { payload: AddToAlbum, success: Done, error: ApiError }),
    kind: "mutation",
    invalidates: ["photos"],
  },
] as const;
