/** Apps whose hosted chrome this stage changes; the others compose exactly as before. */
export const nativePolishedApps = ["wordcraft", "deckcraft"] as const;

type PolishedApp = (typeof nativePolishedApps)[number];

/**
 * Hosted-chrome polish over the composed native source. Word hides its upstream Share button and
 * account avatar inside the Hyori host, which owns sharing and the account; standalone Word keeps
 * both. Deck's Light/Dark toggle keeps one icon in both themes, the one View › Dark Mode uses.
 * Fails closed on every anchor.
 */
export function patchNativePolish(source: ReadonlyMap<string, Buffer>, app: PolishedApp) {
  const files = new Map(source);
  const ui = "crates/ui-egui/src";

  function replace(path: string, before: string, after: string) {
    const body = files.get(path);

    if (!body) throw new Error(`Missing ${app} polish source: ${path}`);
    const text = body.toString();
    const first = text.indexOf(before);

    if (first < 0 || text.indexOf(before, first + before.length) >= 0)
      throw new Error(`${app} polish anchor missing/duplicated: ${path}: ${before}`);
    files.set(path, Buffer.from(text.replace(before, after)));
  }

  if (app === "wordcraft") {
    const ribbon = `${ui}/ribbon.rs`;

    replace(
      ribbon,
      '                let share = tl!("Share");\n',
      '                let share = tl!("Share");\n                // Hyori owns sharing: the hosted strip has no Share button and gives its room to the tabs.\n                let hosted = app.native_host_intents.is_some();\n',
    );
    replace(
      ribbon,
      "                    let share_button = if level < 2 { share_full } else { 30.0 };",
      "                    let share_button = if hosted { -2.0 } else if level < 2 { share_full } else { 30.0 };",
    );
    replace(
      ribbon,
      "                    ui.add_enabled_ui(app.has_document(), |ui| {\n                        let (share_size, share_text) =",
      "                    ui.add_enabled_ui(app.has_document(), |ui| {\n                        if !hosted {\n                        let (share_size, share_text) =",
    );
    replace(
      ribbon,
      '                            let _ = app.run("ui.backstage", json!({"value": true, "page": "export"}));\n                        }\n                        ui.add_space(6.0);\n',
      '                            let _ = app.run("ui.backstage", json!({"value": true, "page": "export"}));\n                        }\n                        ui.add_space(6.0);\n                        }\n',
    );

    const chrome = `${ui}/chrome.rs`;

    // Hyori owns the account: the hosted title bar has no avatar.
    replace(
      chrome,
      "                    // Account / community.\n",
      "                    // Account / community. Hyori owns the account: none inside the host.\n                    if app.native_host_intents.is_none() {\n",
    );
    replace(
      chrome,
      '                        let _ = app.run("ui.backstage", json!({"value": true, "page": "options", "pane": "general"}));\n                    }\n                    ui.add_space(8.0);\n                    search_box(app, ui, control_h);',
      '                        let _ = app.run("ui.backstage", json!({"value": true, "page": "options", "pane": "general"}));\n                    }\n                    ui.add_space(8.0);\n                    }\n                    search_box(app, ui, control_h);',
    );
  } else {
    replace(
      `${ui}/ribbon/title_bar.rs`,
      "            if app.ui.brightness == theme::Brightness::Dark { Icon::Sparkle } else { Icon::Palette },",
      "            // One icon in both themes, as View › Dark Mode draws it.\n            Icon::Palette,",
    );
  }

  return { files };
}
