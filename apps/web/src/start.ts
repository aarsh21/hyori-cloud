import { createMiddleware, createStart } from "@tanstack/react-start";
import { ENV } from "@/env";

const browserSecurity = createMiddleware().server(async ({ next, handlerType }) => {
  if (handlerType !== "router") return next();

  const nonce = crypto.randomUUID();
  const result = await next({ context: { cspNonce: nonce } });

  // Binary/API routes own their stricter sandbox policy; this policy belongs to HTML only.
  if (result.response.headers.get("content-type")?.includes("text/html")) {
    const headers = result.response.headers;
    const development = ENV.NODE_ENV === "development";
    headers.set(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}'${development ? " 'unsafe-eval'" : ""}`,
        "script-src-attr 'none'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' blob: data:",
        "media-src 'self' blob:",
        "font-src 'self'",
        `connect-src 'self'${development ? " ws: wss:" : ""}`,
        "frame-src 'self'",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    headers.set("X-Frame-Options", "DENY");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    );
    headers.set("Cache-Control", "private, no-store");

    if (new URL(ENV.APP_ORIGIN).protocol === "https:")
      headers.set("Strict-Transport-Security", "max-age=31536000");
  }

  return result;
});

export const startInstance = createStart(() => ({ requestMiddleware: [browserSecurity] }));

declare module "@tanstack/react-start" {
  interface Register {
    config: Awaited<ReturnType<typeof startInstance.getOptions>>;
  }
}
