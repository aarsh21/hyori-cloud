import { z } from "zod";
import { nativePalette, nativePaletteToken, rustPaletteColor } from "./native-palette.ts";
import { sha256 } from "./evidence-bytes.ts";

const modeMapping = z.union([
  z.object({ light: nativePaletteToken, dark: nativePaletteToken }).strict(),
  nativePaletteToken.transform((token) => ({ light: token, dark: token })),
]);

type App = "wordcraft" | "gridcraft" | "pdfcraft" | "deckcraft";

type Palette = ReturnType<typeof nativePalette>;

type Token = Parameters<Palette["light"]["get"]>[0];

type Mapping = Readonly<Record<string, Token | { light: Token; dark: Token }>>;

const chromeFields: Record<App, Mapping> = {
  wordcraft: {
    title_bar: "background",
    ribbon: "card",
    tab_strip: "background",
    canvas: "background",
    panel: "card",
    border: "border",
    border_strong: "input",
    text: "foreground",
    text_dim: "muted-foreground",
    text_disabled: "muted-foreground",
    icon: "foreground",
    hover: "accent",
    pressed: "secondary",
    checked: "accent",
    accent: "primary",
    nav: { light: "foreground", dark: "background" },
    accent_text: "foreground",
    on_accent: "primary-foreground",
    input: "card",
    input_border: "input",
    group_label: "muted-foreground",
    ruler: "card",
    ruler_margin: "secondary",
    ruler_tick: "muted-foreground",
    status_bar: "background",
    balloon: "card",
    markup_area: "background",
    markup_edge: "border",
    resolved_text: "success",
    menu: "popover",
    red: "destructive",
    green: "success",
    orange: "warning",
  },
  gridcraft: {
    window: "background",
    ribbon: "card",
    ribbon_border: "border",
    text: "foreground",
    text_dim: "muted-foreground",
    text_disabled: "muted-foreground",
    accent: "primary",
    accent_dark: "foreground",
    accent_soft: "accent",
    hover: "accent",
    pressed: "secondary",
    separator: "border",
    desk: "background",
    header_bg: "card",
    header_text: "foreground",
    header_line: "border",
    header_sel_bg: "accent",
    header_sel_text: "foreground",
    header_all_bg: "secondary",
    input_bg: "card",
    input_border: "input",
    tab_bar: "background",
    tab_active: "card",
    status_bar: "background",
    menu_bg: "popover",
    danger: "destructive",
    on_accent: "primary-foreground",
  },
  pdfcraft: {
    titlebar: "background",
    chrome: "card",
    panel: "card",
    pasteboard: "background",
    card: "card",
    border: "border",
    divider: "border",
    text: "foreground",
    text_muted: "muted-foreground",
    text_faint: "muted-foreground",
    icon: "foreground",
    hover: "accent",
    pressed: "secondary",
    selected: "accent",
    accent: "primary",
    accent_text: "foreground",
    accent_soft: "accent",
    field: "card",
    badge_new: "primary",
  },
  deckcraft: {
    chrome: "background",
    card: "card",
    card_border: "border",
    text_field: "secondary",
    canvas: "background",
    text: "foreground",
    text_dim: "muted-foreground",
    text_faint: "muted-foreground",
    border: "border",
    separator: "border",
    hover: "accent",
    pressed: "secondary",
    selected: "accent",
    accent: "primary",
    accent_text: "primary-foreground",
    contextual: "foreground",
    field_bg: "card",
    control: "input",
    control_hover: "ring",
    control_pressed: "ring",
  },
};

function uniqueIndex(source: string, anchor: string) {
  const at = source.indexOf(anchor);

  if (at < 0 || source.indexOf(anchor, at + anchor.length) >= 0)
    throw new Error(`Native chrome source anchor missing/duplicated: ${anchor}`);

  return at;
}

function rewriteBlock(
  source: string,
  anchor: string,
  end: string,
  mapping: Mapping,
  palette: Palette,
  mode: "light" | "dark" | "paired",
) {
  const start = uniqueIndex(source, anchor);
  const finish = source.indexOf(end, start + anchor.length);

  if (finish < 0) throw new Error(`Native chrome constructor is unclosed: ${anchor}`);
  let block = source.slice(start, finish);

  for (const [field, input] of Object.entries(mapping)) {
    const pair = modeMapping.parse(input);

    const expression = (current: "light" | "dark") => {
      const token = pair[current];
      const color = palette[current].get(token);

      if (!color) throw new Error(`Missing canonical native chrome token: ${token}`);

      return rustPaletteColor(color);
    };

    const value =
      mode === "paired"
        ? `pick(dark, ${expression("light")}, ${expression("dark")})`
        : expression(mode);

    const pattern = new RegExp(`^(\\s+)${field}: [^\\n]*,$`, "gm");
    const matches = [...block.matchAll(pattern)];

    if (matches.length !== 1)
      throw new Error(`Native chrome constructor field missing/duplicated: ${field}`);
    block = block.replace(pattern, `$1${field}: ${value},`);
  }

  return source.slice(0, start) + block + source.slice(finish);
}

/** Source-only new-version patch. Changes native UI token constructors, not document models,
 * fonts, rendering algorithms, shared CSS or any shipping artifact. Rendered acceptance remains required. */
export function patchNativeChrome(source: ReadonlyMap<string, Buffer>, app: App, css: Buffer) {
  const path = "crates/ui-egui/src/theme.rs";
  const original = source.get(path);

  if (!original) throw new Error(`Native chrome source missing: ${path}`);
  const palette = nativePalette(css);
  let text = original.toString();
  const fields = chromeFields[app];

  if (app === "gridcraft") {
    text = rewriteBlock(
      text,
      "    fn palette(dark: bool) -> Tokens {",
      "\n    }",
      fields,
      palette,
      "paired",
    );
  } else if (app === "pdfcraft") {
    text = rewriteBlock(
      text,
      "            ThemeKind::Light => Self {",
      "\n            },",
      fields,
      palette,
      "light",
    );
    text = rewriteBlock(
      text,
      "            ThemeKind::Dark => Self {",
      "\n            },",
      fields,
      palette,
      "dark",
    );
  } else {
    text = rewriteBlock(text, "    pub fn light() -> Self {", "\n    }", fields, palette, "light");
    text = rewriteBlock(text, "    pub fn dark() -> Self {", "\n    }", fields, palette, "dark");
  }

  const files = new Map(source);
  const modified = Buffer.from(text);
  files.set(path, modified);

  return {
    files,
    cssSha256: palette.cssSha256,
    changes: [{ path, before: sha256(original), after: sha256(modified) }],
    mappedChromeFields: Object.keys(fields),
  };
}
