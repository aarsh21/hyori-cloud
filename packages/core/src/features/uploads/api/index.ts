import type { BeginUpload, UploadInput, UploadPartInput } from "#core/features/uploads/api/schema";
import { UploadsService } from "#core/features/uploads/service";
import type { RequestContext } from "#core/runtime";

export function uploadsHandlers(context: RequestContext) {
  const service = new UploadsService(context);

  return {
    "uploads.begin": (input: typeof BeginUpload.Type) => service.begin(input),
    "uploads.status": (input: typeof UploadInput.Type) => service.status(input),
    "uploads.part": (input: typeof UploadPartInput.Type) => service.part(input),
    "uploads.complete": (input: typeof UploadInput.Type) => service.complete(input),
    "uploads.abort": (input: typeof UploadInput.Type) => service.abort(input),
  };
}
