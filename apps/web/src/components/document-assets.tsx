import {
  composeSsrBodyScripts,
  getSsrBodyScriptParts,
  type RouterManagedTag,
} from "@tanstack/router-core";
import { isServer } from "@tanstack/router-core/isServer";
import { Asset, useRouter, useRouterState, useTags } from "@tanstack/react-router";

function documentAsset(asset: RouterManagedTag): RouterManagedTag {
  const external =
    (asset.tag === "script" && Boolean(asset.attrs?.src)) ||
    (asset.tag === "link" && asset.attrs?.rel === "modulepreload");

  // 'self' already authorizes these URLs. A rotating nonce also enters V8's compilation
  // cache identity, including when a modulepreload is the first fetch of the module.
  return external
    ? {
        ...asset,
        attrs: {
          ...asset.attrs,
          nonce: undefined,
          fetchPriority: asset.attrs?.fetchPriority === "low" ? "high" : asset.attrs?.fetchPriority,
        },
      }
    : asset;
}

export function DocumentHead() {
  const tags = useTags();
  const nonce = useRouter().options.ssr?.nonce;

  return tags.map((tag) => {
    const asset = documentAsset(tag);

    return (
      <Asset
        {...asset}
        key={`tsr-meta-${JSON.stringify(tag)}`}
        nonce={asset === tag ? nonce : undefined}
      />
    );
  });
}

export function DocumentScripts() {
  const router = useRouter();
  const matches = useRouterState({ select: (state) => state.matches });

  const parts = getSsrBodyScriptParts(matches, router.ssr?.manifest, router.options.ssr?.nonce, {
    suppressHydrationWarning: true,
  });

  const scripts = composeSsrBodyScripts(
    parts,
    (isServer ?? router.isServer) ? router.serverSsr?.takeInitialHydrationScriptTags() : undefined,
  );

  // Retain the framework's hydration-stream boundary and script execution/hoisting behavior.
  return scripts.map((script, index) => (
    <Asset
      {...documentAsset(script)}
      key={`tsr-scripts-${script.tag}-${index}`}
      preventScriptHoist={Boolean(script.attrs?.src)}
    />
  ));
}
