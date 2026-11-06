import { nativeArtifactVersions } from "./native-frame-patch.ts";
import { patchDeckMarks } from "./deckcraft-marks.ts";

type App = keyof typeof nativeArtifactVersions;

/** Modified builds present Hyori names; "Based on <upstream> by the ArtCraft team" stays as plain text. */
export const nativeProductNames: Record<App, string> = {
  wordcraft: "Hyori Documents",
  gridcraft: "Hyori Spreadsheets",
  pdfcraft: "Hyori PDF",
  deckcraft: "Hyori Presentations",
};

export interface NativeMarksInputs {
  /** The web app's own favicon, unchanged. */
  favicon: Buffer;
  /** The web app's own icon, unchanged. Only native desktop builds embed it. */
  icon: Buffer;
}

const HYORI_MARK = `/// Hyori's mark, drawn in code as in the web app's wordmark. Replaces the ArtCraft marks, which a
/// modified build must not carry (docs/brand/LICENSE-brand.txt).
pub fn hyori_mark(ui: &mut egui::Ui, size: f32) -> Response {
    let (r, response) = ui.allocate_exact_size(vec2(size, size), Sense::hover());
    let brand = Color32::from_rgb(0xC5, 0x2F, 0x37);
    ui.painter().rect_filled(r, CornerRadius::same((size * 0.2) as u8), brand);
    ui.painter().text(r.center(), Align2::CENTER_CENTER, "h", egui::FontId::proportional(size * 0.62), Color32::WHITE);
    response
}

`;

/**
 * Removes ArtCraft marks, community promotion and upstream brand links from a modified web build.
 * Copyright, licence, NOTICE, ATTRIBUTION and docs/brand stay byte-identical. Fails closed on every
 * anchor; Deck reuses the frozen .2 marks patch and only moves its displayed version to .3.
 */
export function patchNativeMarks(
  source: ReadonlyMap<string, Buffer>,
  app: App,
  inputs: NativeMarksInputs,
): Map<string, Buffer> {
  const version = nativeArtifactVersions[app];
  const product = nativeProductNames[app];

  if (app === "deckcraft") {
    const files = patchDeckMarks(new Map(source), inputs).files;
    const about = "crates/ui-egui/src/dialogs/about.rs";
    const text = files.get(about)!.toString();

    if (text.split('"0.14.1-hyori-host.2"').length !== 2)
      throw new Error("Deck About version anchor missing/duplicated");
    files.set(about, Buffer.from(text.replace('"0.14.1-hyori-host.2"', `"${version}"`)));

    return files;
  }

  const files = new Map(source);
  const ui = "crates/ui-egui/src";
  const upstream = `https://github.com/storytold/${app}`;
  const upstreamName = { wordcraft: "WordCraft", gridcraft: "GridCraft", pdfcraft: "PdfCraft" }[
    app
  ];

  function text(path: string) {
    const body = files.get(path);

    if (!body) throw new Error(`Marks source missing: ${path}`);

    return body.toString();
  }

  function replace(path: string, before: string, after: string, count = 1) {
    const body = text(path);

    if (body.split(before).length - 1 !== count)
      throw new Error(`Marks anchor missing/duplicated: ${path}: ${before}`);
    files.set(path, Buffer.from(body.replaceAll(before, () => after)));
  }

  /** Removes `count` whole lines starting at the single line containing `first`. */
  function removeLines(path: string, first: string, count = 1, last?: string) {
    const lines = text(path).split("\n");
    const at = lines.flatMap((line, index) => (line.includes(first) ? [index] : []));

    if (at.length !== 1) throw new Error(`Marks line anchor missing/duplicated: ${path}: ${first}`);

    if (last !== undefined && lines[at[0]! + count - 1]?.trim() !== last)
      throw new Error(`Marks block end changed: ${path}: ${first}`);
    lines.splice(at[0]!, count);
    files.set(path, Buffer.from(lines.join("\n")));
  }

  function add(path: string, body: Buffer) {
    if (files.has(path)) throw new Error(`Refusing to replace marks input: ${path}`);
    files.set(path, body);
  }

  const html = `apps/${app}-web/index.html`;

  if (app === "pdfcraft") {
    replace(html, "<title>PdfCraft</title>", `<title>${product}</title>`);
    replace(
      html,
      '    <link data-trunk rel="rust"',
      '    <link data-trunk rel="icon" href="hyori-mark.ico" />\n    <link data-trunk rel="rust"',
    );
  } else {
    replace(html, `<title>${upstreamName}</title>`, `<title>${product}</title>`);
    replace(html, `href="../../assets/app-icon/${app}.ico"`, 'href="hyori-mark.ico"');
    replace(html, `Loading ${upstreamName}&hellip;`, `Loading ${product}&hellip;`);
    replace(
      `apps/${app}-web/src/web.rs`,
      `<p>${upstreamName} failed to start:`,
      `<p>${product} failed to start:`,
    );
  }

  add(`apps/${app}-web/hyori-mark.ico`, inputs.favicon);
  // Desktop-only update prompt icon; replaced so no modified build embeds the upstream app icon.
  replace(
    `${ui}/lib.rs`,
    `"../../../assets/app-icon/hicolor/128x128/apps/ai.storyteller.${app}.png"`,
    '"../../../assets/hyori-mark.png"',
  );
  add("assets/hyori-mark.png", inputs.icon);

  if (app === "wordcraft") {
    removeLines(`${ui}/chrome.rs`, "if app.ui.show_discord {", 16, "}");
    removeLines(`${ui}/options.rs`, "app.ui.show_discord");
    removeLines(`${ui}/ribbon/review.rs`, '"ui.discord"');
    replace(`${ui}/keytips.rs`, 'c("Community Discord", "ui.discord"), ', "");
    replace(
      `${ui}/backstage.rs`,
      '[("About", "about"), ("Discord community", "discord")]',
      '[("About", "about")]',
    );
    replace(`${ui}/app/commands.rs`, '"https://discord.gg/artcraft"', `"${upstream}"`);
    // Exported LaTeX carries this line into the person's own file.
    replace(
      "crates/formats/src/latex/export.rs",
      'o.push_str("% Written by WordCraft (https://getartcraft.com/apps/wordcraft).\\n");',
      `o.push_str("% Written by ${product}, based on WordCraft (${upstream}).\\n");`,
    );
    replace(
      "crates/engine/src/sample.rs",
      'link: Some("https://getartcraft.com/".into())',
      `link: Some("${upstream}".into())`,
    );
    // Zotero needs the desktop app; the tab is upstream promotion with no function in the browser.
    replace(
      `${ui}/ribbon.rs`,
      "tabs.extend(user_tabs.iter().filter(|e| !e.hidden).map(",
      'tabs.extend(user_tabs.iter().filter(|e| !e.hidden && e.name != "Zotero").map(',
    );

    const dispatch = `${ui}/dialogs/dispatch.rs`;

    replace(
      dispatch,
      'ui.label(egui::RichText::new(tl!("WordCraft")).font(semibold(22.0)));',
      `ui.label(egui::RichText::new("${product}").font(semibold(22.0)));`,
    );
    replace(dispatch, '("version", env!("CARGO_PKG_VERSION"))', `("version", "${version}")`);
    replace(
      dispatch,
      'ui.label(tl!("A free, open-source word processor written from scratch in Rust.\\nPart of the Crafting Apps from the ArtCraft team."));',
      'ui.label("Based on WordCraft by the ArtCraft team. This modified version is not an official ArtCraft product.");',
    );
    removeLines(dispatch, '"https://getartcraft.com/apps/wordcraft"');
    removeLines(dispatch, '"https://discord.gg/artcraft"');
    replace(
      dispatch,
      'ui.hyperlink_to(tl!("Source code: github.com/storytold/wordcraft"), ',
      'ui.hyperlink_to("WordCraft source on GitHub", ',
    );

    replace(`${ui}/chrome.rs`, '"WordCraft".to_string()', `"${product}".to_string()`);
    replace(`${ui}/windows.rs`, '"{name}{} - WordCraft"', `"{name}{} - ${product}"`);
    replace(
      `${ui}/windows.rs`,
      'return "WordCraft".to_string();',
      `return "${product}".to_string();`,
    );
    replace(`${ui}/windows.rs`, 'with_title("WordCraft")', `with_title("${product}")`);
    replace(`${ui}/dialogs/chrome.rs`, '"About WordCraft"', `"About ${product}"`);
    replace(
      `${ui}/dialogs/chrome.rs`,
      'Dialog::SaveChanges { .. } => "WordCraft"',
      `Dialog::SaveChanges { .. } => "${product}"`,
    );
  } else if (app === "gridcraft") {
    const about = `${ui}/dialogs/about.rs`;

    replace(about, 'ui.heading("GridCraft");', `ui.heading("${product}");`);
    replace(
      about,
      'format!("Version {}", env!("CARGO_PKG_VERSION"))',
      `format!("Version {}", "${version}")`,
    );
    replace(
      about,
      '"A clean-room, open-source, Rust-native spreadsheet. Part of ArtCraft."',
      '"Based on GridCraft by the ArtCraft team. This modified version is not an official ArtCraft product."',
    );
    replace(
      about,
      'ui.hyperlink_to("getartcraft.com/apps/gridcraft", "https://getartcraft.com/apps/gridcraft");',
      `ui.hyperlink_to("GridCraft source on GitHub", "${upstream}");`,
    );
    removeLines(about, '"https://discord.gg/artcraft"');
    replace(`${ui}/dialogs.rs`, '"About GridCraft"', `"About ${product}"`);
    replace(
      `${ui}/dialogs.rs`,
      'Dialog::custom("start", "GridCraft",',
      `Dialog::custom("start", "${product}",`,
    );
    replace(`${ui}/backstage.rs`, 'RichText::new("GridCraft")', `RichText::new("${product}")`);
    replace(`${ui}/backstage.rs`, 'lang.tr("About GridCraft")', `"About ${product}"`, 2);
    replace(
      `${ui}/backstage.rs`,
      '("Version", env!("CARGO_PKG_VERSION").to_string())',
      `("Version", "${version}".to_string())`,
    );
    replace(`${ui}/ribbon/automate.rs`, '"About\\nGridCraft"', '"About"');
    replace(
      `${ui}/ribbon/automate.rs`,
      '"Look for a newer GridCraft release"',
      '"Look for a newer release"',
    );
    replace(`${ui}/app/editing.rs`, '"GridCraft".to_string()', `"${product}".to_string()`);

    // Alert titles name the product.
    let titles = 0;

    for (const [path, body] of files) {
      if (!path.startsWith(`${ui}/`) || !path.endsWith(".rs") || path.includes("/i18n/")) continue;
      const count = body.toString().split('("GridCraft".into(),').length - 1;

      if (count === 0) continue;
      replace(path, '("GridCraft".into(),', `("${product}".into(),`, count);
      titles += count;
    }

    if (titles === 0) throw new Error("Grid alert title anchors missing");
  } else {
    const widgets = `${ui}/widgets.rs`;
    const body = text(widgets);
    const start = body.indexOf("/// The ArtCraft wordmark");
    const end = body.indexOf("/// Buttons for every community link");

    if (start < 0 || end < start || body.indexOf("/// The ArtCraft wordmark", start + 1) >= 0)
      throw new Error("PDF ArtCraft logo region missing/duplicated");
    files.set(widgets, Buffer.from(body.slice(0, start) + HYORI_MARK + body.slice(end)));
    replace(
      widgets,
      'let resp = if i == 0 { icon_pill(ui, l.icon, tl!("Join our Discord"), true) } else { icon_pill(ui, l.icon, tl!(l.label), false) };',
      "let resp = icon_pill(ui, l.icon, tl!(l.label), i == 0);",
    );
    replace(`${ui}/home.rs`, "widgets::artcraft_mark(ui, 28.0);", "widgets::hyori_mark(ui, 28.0);");
    replace(`${ui}/home.rs`, 'tl!("Welcome to PdfCraft")', `"Welcome to ${product}"`);
    // The community card only promoted the upstream community; it starts (and stays) closed.
    replace(`${ui}/app.rs`, "community_card_closed: false,", "community_card_closed: true,");
    replace(
      `${ui}/home.rs`,
      'tl!("Join the ArtCraft community")',
      '"Based on PdfCraft by the ArtCraft team"',
    );
    replace(
      `${ui}/home.rs`,
      'tl!("Get help, share feedback and follow development on Discord.")',
      '"Its source code is on GitHub."',
    );
    replace(
      `${ui}/app.rs`,
      '|| "PdfCraft".to_owned(), |name| format!("{name}{mark} — PdfCraft")',
      `|| "${product}".to_owned(), |name| format!("{name}{mark} — ${product}")`,
    );
    replace(
      `${ui}/menus.rs`,
      'pub(crate) const APP_NAME: &str = "PdfCraft";',
      `pub(crate) const APP_NAME: &str = "${product}";`,
    );
    replace(
      `${ui}/menus.rs`,
      '"help.app_page", "help.github", "help.website", "help.discord", SEP,',
      '"help.github", SEP,',
    );

    const dialogs = `${ui}/dialogs.rs`;

    replace(dialogs, "widgets::artcraft_mark(ui, 40.0);", "widgets::hyori_mark(ui, 40.0);");
    replace(
      dialogs,
      'egui::RichText::new("PdfCraft").font(theme::semibold(20.0))',
      `egui::RichText::new("${product}").font(theme::semibold(20.0))`,
    );
    replace(dialogs, '&[("v", &pdfcraft_engine::build_info::version())]', `&[("v", "${version}")]`);
    replace(
      dialogs,
      `            ui.horizontal(|ui| {
                ui.label(egui::RichText::new(tl!("Part of")).color(t.text_muted));
                widgets::artcraft_logo(ui, 16.0);
            });`,
      '            ui.label(egui::RichText::new("Based on PdfCraft by the ArtCraft team. This modified version is not an official ArtCraft product.").color(t.text_muted));',
    );

    const chrome = `${ui}/chrome.rs`;

    replace(
      chrome,
      'ui.fonts_mut(|f| f.layout_no_wrap("Discord".into(), theme::medium(13.0), t.text).size().x)\n                    + 3.0 * button',
      "3.0 * button",
    );
    removeLines(chrome, "// One click to the community, from anywhere in the app.", 4, "}");

    const commands = "crates/engine/src/commands.rs";

    for (const id of ["help.discord", "help.app_page", "help.website"])
      removeLines(commands, `c("${id}",`);

    const links = "crates/engine/src/links.rs";

    replace(links, '"https://discord.gg/artcraft"', `"${upstream}"`);
    replace(
      links,
      'pub const WEBSITE: &str = "https://getartcraft.com";',
      `pub const WEBSITE: &str = "${upstream}";`,
    );
    replace(links, '"https://getartcraft.com/apps/pdfcraft"', `"${upstream}"`);

    for (const id of ["help.discord", "help.app_page", "help.website"])
      removeLines(links, `Link { command: "${id}"`);
  }

  if (!files.get("Cargo.lock")?.equals(source.get("Cargo.lock")!))
    throw new Error("Marks patch must preserve Cargo.lock");

  return files;
}
