import { z } from "zod";
import { sha256 } from "./evidence-bytes.ts";

export const nativePaletteToken = z.enum([
  "background",
  "foreground",
  "card",
  "popover",
  "primary",
  "primary-foreground",
  "secondary",
  "muted-foreground",
  "accent",
  "border",
  "input",
  "ring",
  "destructive",
  "success",
  "warning",
]);

type TokenName = z.infer<typeof nativePaletteToken>;

type Rgba = readonly [number, number, number, number];

const oklch = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+)%)?\)$/;

function rgba(value: string): Rgba {
  const match = oklch.exec(value);

  if (!match) throw new Error(`Unsupported canonical palette syntax: ${value}`);
  const lightness = z.coerce.number().min(0).max(1).parse(match[1]);
  const chroma = z.coerce.number().min(0).max(0.5).parse(match[2]);
  const hue = (z.coerce.number().min(0).max(360).parse(match[3]) * Math.PI) / 180;

  const alpha =
    match[4] === undefined
      ? 255
      : Math.round(z.coerce.number().min(0).max(100).parse(match[4]) * 2.55);

  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  function channel(linear: number) {
    const encoded = linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;

    return Math.round(Math.max(0, Math.min(1, encoded)) * 255);
  }

  return [
    channel(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    channel(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    channel(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    alpha,
  ];
}

/** Read actual shared CSS tokens; DESIGN's approximate hex descriptions are not a second palette. */
export function nativePalette(css: Buffer) {
  const text = css.toString();

  function mode(selector: ":root" | ".dark") {
    const start = text.indexOf(`${selector} {`);

    if (start < 0 || text.indexOf(`${selector} {`, start + 1) >= 0)
      throw new Error(`Canonical palette selector missing/duplicated: ${selector}`);
    const end = text.indexOf("\n}", start);

    if (end < 0) throw new Error("Canonical palette selector is unclosed");
    const block = text.slice(start, end);
    const values = new Map<TokenName, Rgba>();

    for (const name of nativePaletteToken.options) {
      const occurrences = [...block.matchAll(new RegExp(`^  --${name}: ([^;]+);$`, "gm"))];

      if (occurrences.length !== 1)
        throw new Error(`Canonical palette token missing/duplicated: ${selector} --${name}`);
      values.set(name, rgba(occurrences[0]![1]!));
    }

    return values;
  }

  return { cssSha256: sha256(css), light: mode(":root"), dark: mode(".dark") };
}

export function rustPaletteColor(color: Rgba) {
  return `Color32::from_rgba_unmultiplied(${color.join(", ")})`;
}
