import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const stylesheet = readFileSync(
  new URL("../../../packages/ui/src/styles/globals.css", import.meta.url),
  "utf8",
);

type Color = { luminance: number; alpha: number };

function readPalette(selector: string) {
  const block = stylesheet.split(`${selector} {`)[1]?.split("}")[0];

  if (!block) throw new Error(`Missing palette: ${selector}`);

  const colors = new Map<string, Color>();

  for (const match of block.matchAll(
    /--([\w-]+): oklch\(([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+)%)?\)/g,
  )) {
    const [, name, lightness, chroma, hue, opacity] = match;
    const L = Number(lightness);
    const angle = (Number(hue) * Math.PI) / 180;
    const a = Number(chroma) * Math.cos(angle);
    const b = Number(chroma) * Math.sin(angle);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const clamp = (channel: number) => Math.min(1, Math.max(0, channel));
    const r = clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
    const g = clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
    const blue = clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);

    colors.set(name!, {
      luminance: 0.2126 * r + 0.7152 * g + 0.0722 * blue,
      alpha: opacity === undefined ? 1 : Number(opacity) / 100,
    });
  }

  return (name: string) => {
    const color = colors.get(name);

    if (!color) throw new Error(`Missing ${selector} color: ${name}`);

    return color;
  };
}

function contrast(first: Color, second: Color) {
  expect(first.alpha).toBe(1);
  expect(second.alpha).toBe(1);

  return (
    (Math.max(first.luminance, second.luminance) + 0.05) /
    (Math.min(first.luminance, second.luminance) + 0.05)
  );
}

for (const selector of [":root", ".dark"]) {
  const color = readPalette(selector);

  for (const surface of ["background", "card", "popover", "sidebar", "muted", "accent"]) {
    test(`${selector} ${surface}: body, secondary and error text meet 4.5:1`, () => {
      for (const text of ["foreground", "muted-foreground", "destructive"]) {
        expect(contrast(color(text), color(surface))).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  test(`${selector}: primary and destructive buttons keep readable labels`, () => {
    for (const token of ["primary", "destructive"]) {
      expect(contrast(color(`${token}-foreground`), color(token))).toBeGreaterThanOrEqual(4.5);
    }
  });

  test(`${selector}: Photos placeholders, completed transfers and focus borders are distinct`, () => {
    expect(contrast(color("muted-foreground"), color("muted"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(color("success"), color("popover"))).toBeGreaterThanOrEqual(3);
    expect(contrast(color("ring"), color("card"))).toBeGreaterThanOrEqual(3);
    expect(contrast(color("ring"), color("popover"))).toBeGreaterThanOrEqual(3);
  });
}
