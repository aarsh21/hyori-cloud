import { plugin } from "bun";

// Bun executes source, not Vite's asset pipeline. Only the CSS URL is adapted; application,
// provider, router, feature, SDK and server modules are never replaced.
plugin({
  name: "test-stylesheet-url",
  setup(builder) {
    builder.onLoad({ filter: /\.css\?url$/ }, () => ({
      contents: 'export default "/test-stylesheet.css";',
      loader: "js",
    }));
  },
});
