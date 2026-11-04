import { renderToString } from "react-dom/server";
import { AppearanceSurface } from "./appearance-surface.tsx";

if ("window" in globalThis || "document" in globalThis || "localStorage" in globalThis) {
  throw new Error("The appearance SSR fixture must run without browser globals");
}

process.stdout.write(renderToString(<AppearanceSurface />));
