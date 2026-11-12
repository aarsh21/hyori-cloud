import { plugin } from "bun";
import { mock } from "bun:test";

// Bun executes source, not Vite's asset pipeline. Only CSS URLs and the generated chunk map are
// adapted; application, provider, router, feature, SDK and server modules are never replaced.
plugin({
  name: "test-stylesheet-url",
  setup(builder) {
    builder.onLoad({ filter: /\.css\?url$/ }, () => ({
      contents: 'export default "/test-stylesheet.css";',
      loader: "js",
    }));
  },
});

mock.module("virtual:hyori-screen-assets", () => ({ default: {} }));
