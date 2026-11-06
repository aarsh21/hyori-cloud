import { sha256 } from "./evidence-bytes.ts";

export const DECK_MARKS_VERSION = "0.14.1-hyori-host.2";

const PRODUCT = "Hyori Presentations";

// The upstream repository stays reachable as plain attribution. Everything else pointed at the
// ArtCraft community and site, which a modified build must not present itself as part of.
const UPSTREAM_SOURCE = "https://github.com/storytold/deckcraft";

/** The same mark as the web app's wordmark: lower-case h, white, on Hyori's brand red. */
const HYORI_LOGO = `/// Hyori's mark, drawn in code as in the web app's wordmark. Replaces DeckCraft's mark, which a
/// modified build must not carry (docs/brand/LICENSE-brand.txt).
pub fn paint_logo(p: &egui::Painter, r: Rect) {
    let brand = Color32::from_rgb(0xC5, 0x2F, 0x37);
    let card = r.shrink(r.width() * 0.08);
    p.rect_filled(card, CornerRadius::same((r.width() * 0.2) as u8), brand);
    p.text(
        card.center(),
        egui::Align2::CENTER_CENTER,
        "h",
        egui::FontId::proportional(card.height() * 0.62),
        Color32::WHITE,
    );
}`;

export interface DeckMarksInputs {
  /** The web app's own favicon, unchanged. */
  favicon: Buffer;
  /** The web app's own icon, unchanged. Only native builds embed it. */
  icon: Buffer;
}

function between(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);

  if (from < 0 || to < 0 || source.indexOf(start, from + start.length) >= 0) {
    throw new Error(`Nonunique patch region: ${start}`);
  }

  return source.slice(from, to);
}

/**
 * Replaces the marks and product identity for a distributed modified build, on top of the host
 * patch, and makes an ordinary Save of a PPTX produce a native copy. Fails closed on every upstream anchor. Copyright, licence, NOTICE and ATTRIBUTION are not
 * touched, and the plain-text attribution the brand licence allows is added.
 */
export function patchDeckMarks(patched: Map<string, Buffer>, inputs: DeckMarksInputs) {
  const files = new Map(patched);

  function replace(path: string, before: string, after: string) {
    const source = files.get(path)?.toString();

    if (!source || source.split(before).length !== 2) {
      throw new Error(`Nonunique patch anchor: ${path}: ${before}`);
    }

    files.set(path, Buffer.from(source.replace(before, () => after)));
  }

  const html = "apps/deckcraft-web/index.html";

  replace(html, "<title>DeckCraft</title>", `<title>${PRODUCT}</title>`);
  replace(html, 'href="../../assets/app-icon/deckcraft.ico"', 'href="hyori-mark.ico"');
  replace(html, "Loading DeckCraft&hellip;", `Loading ${PRODUCT}&hellip;`);
  files.set("apps/deckcraft-web/hyori-mark.ico", inputs.favicon);

  replace(
    "apps/deckcraft-web/src/web.rs",
    "<p>DeckCraft failed to start:",
    `<p>${PRODUCT} failed to start:`,
  );
  replace(
    "apps/deckcraft-web/src/host.rs",
    'const VERSION: &str = "0.14.1-hyori-host.1";',
    `const VERSION: &str = "${DECK_MARKS_VERSION}";`,
  );

  const lib = "crates/ui-egui/src/lib.rs";

  replace(
    lib,
    '"../../../assets/app-icon/hicolor/128x128/apps/ai.storyteller.deckcraft.png"',
    '"../../../assets/hyori-mark.png"',
  );
  replace(lib, "accent: Some([0xf0, 0x7a, 0x1e]),", "accent: Some([0xc5, 0x2f, 0x37]),");
  replace(lib, '("app.about", "About DeckCraft",', `("app.about", "About ${PRODUCT}",`);
  files.set("assets/hyori-mark.png", inputs.icon);

  const about = "crates/ui-egui/src/dialogs/about.rs";
  const aboutSource = files.get(about)?.toString() ?? "";

  const drawnMark = between(
    aboutSource,
    "/// DeckCraft's mark, drawn in code",
    "#[cfg(test)]\nmod about_credits_tests",
  );

  replace(about, drawnMark, `${HYORI_LOGO}\n\n`);
  replace(
    about,
    'egui::RichText::new("DeckCraft").font(theme::bold(22.0))',
    `egui::RichText::new("${PRODUCT}").font(theme::bold(22.0))`,
  );
  replace(about, 'env!("CARGO_PKG_VERSION")', `"${DECK_MARKS_VERSION}"`);
  replace(
    about,
    'ui.hyperlink_to("Join our community on Discord", deckcraft_engine::links::DISCORD);\n        ui.hyperlink_to("getartcraft.com/apps/deckcraft", deckcraft_engine::links::APP_PAGE);\n        ui.hyperlink_to("Source on GitHub", deckcraft_engine::links::GITHUB);',
    'ui.label("Based on DeckCraft by the ArtCraft team.");\n        ui.hyperlink_to("DeckCraft source on GitHub", deckcraft_engine::links::GITHUB);',
  );

  const info = "crates/ui-egui/src/backstage/info.rs";

  replace(info, '"DeckCraft has no accounts:', '"This editor has no accounts of its own:');
  replace(
    info,
    'RichText::new("DeckCraft").font(theme::bold(24.0))',
    `RichText::new("${PRODUCT}").font(theme::bold(24.0))`,
  );
  replace(
    info,
    '"About DeckCraft",\n                "About DeckCraft",',
    `"About ${PRODUCT}",\n                "About ${PRODUCT}",`,
  );
  replace(
    info,
    'ui.hyperlink_to("Join our community on Discord", deckcraft_engine::links::DISCORD);\n            ui.hyperlink_to("Source on GitHub", deckcraft_engine::links::GITHUB);',
    'dim(ui, "Based on DeckCraft by the ArtCraft team.");\n            ui.hyperlink_to("DeckCraft source on GitHub", deckcraft_engine::links::GITHUB);',
  );

  const home = "crates/ui-egui/src/backstage/files.rs";

  replace(
    home,
    'RichText::new("DeckCraft").font(theme::bold(24.0))',
    `RichText::new("${PRODUCT}").font(theme::bold(24.0))`,
  );
  replace(
    home,
    '    ui.add_space(30.0);\n    ui.hyperlink_to("Join the ArtCraft community on Discord", deckcraft_engine::links::DISCORD);\n',
    "",
  );

  replace(
    "crates/ui-egui/src/menus.rs",
    '("About DeckCraft", "app.about")',
    `("About ${PRODUCT}", "app.about")`,
  );

  const dialogs = "crates/ui-egui/src/dialogs.rs";

  replace(dialogs, '"about" => "About DeckCraft",', `"about" => "About ${PRODUCT}",`);
  replace(dialogs, '"quit" => "DeckCraft",', `"quit" => "${PRODUCT}",`);
  replace(dialogs, '_ => "DeckCraft",', `_ => "${PRODUCT}",`);

  replace(
    "crates/ui-egui/src/ribbon/title_bar.rs",
    '.unwrap_or_else(|| "DeckCraft".into())',
    `.unwrap_or_else(|| "${PRODUCT}".into())`,
  );
  replace(
    "crates/ui-egui/src/show/presenter.rs",
    '"Presenter View — DeckCraft"',
    `"Presenter View — ${PRODUCT}"`,
  );

  const find = "crates/ui-egui/src/dialogs/find.rs";

  replace(find, "Err(_) => format!(\"DeckCraft can't find", "Err(_) => format!(\"Can't find");
  replace(
    find,
    'd.fields.insert("status".into(), format!("DeckCraft can\'t find',
    'd.fields.insert("status".into(), format!("Can\'t find',
  );

  const app = "crates/ui-egui/src/app/files.rs";

  // Host saves only accept formats the host's descriptor allows, which never includes PPTX. So an
  // ordinary Save of a PPTX makes a native copy, and the host asks where it goes. Without this, it
  // fails with nothing but a status line. The source PPTX is never replaced.
  replace(
    app,
    `        let name = match format {
            Some(ext) => format!("{}.{}", d.title(), ext),
            None => d.path.clone().ok_or("No host output filename")?,
        };`,
    `        let (name, save_as) = match format {
            Some(ext) => (format!("{}.{}", d.title(), ext), save_as),
            None => {
                let path = d.path.clone().ok_or("No host output filename")?;

                if path.to_ascii_lowercase().ends_with(".pptx") {
                    (format!("{}.deckcraft", d.title()), true)
                } else {
                    (path, save_as)
                }
            }
        };`,
  );

  replace(
    app,
    "{name}: DeckCraft can't open this kind",
    "{name}: this editor can't open this kind",
  );
  replace(app, "format!(\"DeckCraft can't export", "format!(\"This editor can't export");

  const print = "crates/ui-egui/src/backstage/print.rs";

  replace(
    print,
    '"DeckCraft prints through a PDF: it opens',
    '"This editor prints through a PDF: it opens',
  );
  replace(
    print,
    '"DeckCraft prints through a PDF: it downloads',
    '"This editor prints through a PDF: it downloads',
  );

  const links = "crates/engine/src/links.rs";

  replace(links, '"https://discord.gg/artcraft"', `"${UPSTREAM_SOURCE}"`);
  replace(links, '"https://getartcraft.com/"', `"${UPSTREAM_SOURCE}"`);
  replace(links, '"https://getartcraft.com/apps"', `"${UPSTREAM_SOURCE}"`);
  replace(links, '"https://getartcraft.com/apps/deckcraft"', `"${UPSTREAM_SOURCE}"`);

  const changes: { path: string; before: string | null; after: string }[] = [];

  for (const [path, bytes] of files) {
    const before = patched.get(path);

    if (!before || !bytes.equals(before)) {
      changes.push({ path, before: before ? sha256(before) : null, after: sha256(bytes) });
    }
  }

  if (files.get("Cargo.lock")?.equals(patched.get("Cargo.lock")!) !== true) {
    throw new Error("Patch must preserve Cargo.lock");
  }

  return { files, changes };
}
