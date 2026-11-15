---
version: alpha
name: Hyori Cloud
description: Restrained product UI on near-black or warm porcelain, with hairlines, quiet type, keyboard-first density, and one small flare of red.
---

# Hyori Cloud design language

A quiet, dense workspace for files. Neutral surfaces and hairlines carry the structure; the user's files, photos, and names carry the interest; red appears rarely enough to mean something.

## Provenance

Adapted from the **Raycats** design flavor (https://flavors.design/f/raycats), supplied by the project owner on 2026-11-05 as `DESIGN.md`-format text with reference CSS and a full HTML sample (SHA-256 `166cf8472930c95008271f7e15ecacd0383eed6e7bd4037dae224c8163535d65`). The source states no license, so this file keeps its design values and rules and leaves out its prose, CSS, HTML, and embedded image. Raycats describes a marketing page; everything below is rewritten for an application.

## Precedence

When guidance conflicts, the earlier source wins:

1. `AGENTS.md` and `docs/product.md`: accessibility, performance, shared UI, confirmed scope, and Light/Dark/System appearance.
2. This file: visual language.
3. The Raycats source, for anything not settled above.

## Tokens

`packages/ui/src/styles/globals.css` owns shipped values, and this table records their intent. Build with its semantic tokens so a palette change stays a one-file edit, and keep color literals out of features.

| Role         | Token                       | Dark        | Light      |
| ------------ | --------------------------- | ----------- | ---------- |
| Ground       | `--background`, `--sidebar` | `#07080a`   | `#f1eee8`  |
| Raised       | `--card`, `--popover`       | `#111214`   | `#fffdf9`  |
| Ink          | `--foreground`              | `#ffffff`   | `#181614`  |
| Muted text   | `--muted-foreground`        | `#9c9c9d`   | `#68635d`  |
| Hairline     | `--border`                  | white at 8% | ink at 11% |
| Control edge | `--input`                   | 3:1 solid   | 3:1 solid  |
| Primary fill | `--primary`                 | near-white  | near-ink   |
| Brand accent | `--brand`                   | `#ff6363`   | `#c52f37`  |

Light comes from the source's Porcelain scheme, with muted text darkened slightly to hold 4.5:1 on hover fills. The app frame is ground with a raised sheet inset on it, in both modes. Both modes stay first-class: check every change in Light, Dark, and System. `apps/web/test/theme-contrast.test.ts` enforces the contrast pairs.

`--accent` is shadcn's neutral hover fill, not this red. Keep them separate.

## Color

- **Brand red marks identity and one current state at a time:** the logo, a checked checkbox, the active-filter dot. Navigation and switches stay neutral. Primary actions stay on `--primary`, and most screens show almost no red.
- **Danger reads through its own means.** `--destructive` is also red, so a destructive action always carries an explicit label, and an irreversible one a confirmation naming the object. Red alone never signals danger, and brand red is never used for it.
- `--success`, `--warning`, and `--destructive` keep their status meanings. Skip the source's blue, green, yellow, and violet accents; file-type and data color come from the semantic tokens or an approved addition.
- Emphasize with ink against muted text, not color or bold.

## Type

- Inter for all interface text, already self-hosted through `packages/ui`. Keep its existing font features.
- Geist Mono only for machine values with no better form: IDs, hashes, and code. Add it through `@fontsource` in `packages/ui` when first needed, and evaluate its bundle cost. Self-hosted instances load no fonts from a third-party CDN.
- Show file sizes, counts, and dates in Inter with tabular figures.
- Weights are 400, 500, and 600, with 500 as the workhorse. Navigation and file names are 14px, controls and secondary copy 13px, meta 12px, with an 11px floor. Screen titles are 18–24px at `-0.02em`. Sentence case throughout, and right-align numeric columns.

## Surfaces and shape

- Separate surfaces with 1px hairlines rather than color blocks. Hairlines are for structure; inputs, checkboxes, focus, and selection need a boundary or indicator that meets 3:1 non-text contrast, so focus rings render at full `--ring` strength unless a `--ring` border already carries them.
- Keep resting surfaces flat. In Dark, a raised panel may take a 1px inset top highlight at about 10% white. Use the `--shadow-*` tokens only for what floats: menus, popovers, dialogs.
- Surfaces are opaque by default. Translucency with blur up to 12px is limited to floating chrome and overlays, must preserve text contrast, and never sits over a scrolling list or grid. Glows and gradients stay out of product UI.
- Radius steps: 4–6px on chips and rows, 8px on buttons and inputs, 12–16px on panels and dialogs, full on avatars and status dots.
- Spacing sits on a 4px base. Panels are tight: compact rows, small gaps, generous space only between regions. Pointer rows may run 28–36px; on `coarse` pointers, targets reach 44px.
- Show `Kbd` hints only for enabled shortcuts that exist, using the shared component. Bare single-key shortcuts have a locally remembered off switch; navigation remains usable with standard keyboard controls.
- The sidebar is `packages/ui`'s adapted shadcn sidebar. Its toggle is one fixed element that keeps the same position open and collapsed, and collapsing is immediate. Phones use the bottom navigation instead.

## Motion

Follow `AGENTS.md`. Use `--ease-out` (the source's `cubic-bezier(.23, 1, .32, 1)`), at most 200ms on occasional transitions. List navigation and keyboard actions respond immediately. Surfaces brighten on hover rather than lift. Nothing animates on entrance or on scroll.

## Left out

These belong to the source's marketing page and are not part of product UI: red light-streak artwork and the hero photograph, drawn desktop and launcher mocks, keycap decorations, dot grids and `FIG` captions, tinted bento and pricing tiles, the pill navigation, machined button shadows, 64px headlines and 128px section rhythm, the Google Fonts link, the alternate schemes and tweak controls, and the dark-only rule. An approved public landing page would revisit the artwork, as a new decision.
