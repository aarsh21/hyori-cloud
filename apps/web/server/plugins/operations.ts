import { definePlugin } from "nitro";
import { withOperations } from "../../src/server/operations";

export default definePlugin((app) => {
  app.fetch = withOperations(app.fetch, process.env.HYORI_BACKEND_URL);
});
