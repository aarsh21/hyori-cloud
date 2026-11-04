import { setInterval, clearInterval } from "node:timers";
import { createHandler } from "@hyori-cloud/api";
import { createServerOnlyFn } from "@tanstack/react-start";

import { ENV } from "@/env";

let apiHandler: ReturnType<typeof createHandler> | undefined;

function startMaintenance(handler: ReturnType<typeof createHandler>): void {
  let running = false;

  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void handler
      .maintenance()
      .catch(() => {
        console.error("Hyori maintenance failed; the next scheduled sweep will retry.");
      })
      .finally(() => {
        running = false;
      });
  }, 60_000);

  timer.unref();

  const dispose = () => {
    clearInterval(timer);
    handler.dispose();
    process.off("exit", dispose);
  };

  process.once("exit", dispose);
  import.meta.hot?.dispose(dispose);
}

function requiredSecret(value: string | undefined, name: string): string {
  if (!value || value.startsWith("replace-with-")) {
    throw new Error(`Configure ${name} in the web application's environment.`);
  }

  return value;
}

export const handleApiRequest = createServerOnlyFn(async (request: Request): Promise<Response> => {
  try {
    if (!apiHandler) {
      apiHandler = createHandler({
        origin: ENV.APP_ORIGIN,
        setupToken: requiredSecret(ENV.HYORI_SETUP_TOKEN, "HYORI_SETUP_TOKEN"),
        secureCookies: ENV.APP_ENV === "production",
        basePath: "/api/rpc",
        storagePath: "/api/storage",
        surreal: {
          url: ENV.SURREALDB_URL,
          namespace: ENV.SURREALDB_NAMESPACE,
          database: ENV.SURREALDB_DATABASE,
          username: ENV.SURREALDB_USERNAME,
          password: requiredSecret(ENV.SURREALDB_PASSWORD, "SURREALDB_PASSWORD"),
        },
        storage: {
          endpoint: ENV.RUSTFS_ENDPOINT,
          region: ENV.RUSTFS_REGION,
          bucket: ENV.RUSTFS_BUCKET,
          accessKeyId: requiredSecret(ENV.RUSTFS_ACCESS_KEY, "RUSTFS_ACCESS_KEY"),
          secretAccessKey: requiredSecret(ENV.RUSTFS_SECRET_KEY, "RUSTFS_SECRET_KEY"),
        },
        defaultQuotaBytes: ENV.DEFAULT_QUOTA_BYTES,
      });
      startMaintenance(apiHandler);
    }
  } catch {
    return Response.json(
      {
        ok: false,
        error: {
          code: "service.unavailable",
          message:
            "Server configuration is incomplete. Configure the backend environment before setup.",
        },
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  return apiHandler(request);
});
