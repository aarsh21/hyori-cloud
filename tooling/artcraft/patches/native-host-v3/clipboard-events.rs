/// eframe forwards both the shortcut key and its browser clipboard event. The native apps
/// handle both, unlike egui-winit which forwards only the clipboard event. Prefer that event
/// when present; without it, preserve the native clipboard command. The app reports whether
/// Paste Formatting can apply a copied format, so a plain shifted paste still works without one.
fn clipboard_events_only(events: &mut Vec<egui::Event>, has_copied_format: bool) {
    use egui::{Event, Key};
    let paste = events.iter().any(|event| matches!(event, Event::Paste(_)));
    let cut = events.iter().any(|event| matches!(event, Event::Cut));
    let copy = events.iter().any(|event| matches!(event, Event::Copy));
    let formatting_paste = has_copied_format && events.iter().any(|event| matches!(event,
        Event::Key { key: Key::V, pressed: true, modifiers: m, .. }
            if m.command && m.shift && !m.alt));
    events.retain(|event| match event {
        Event::Paste(_) if formatting_paste => false,
        Event::Key { key, pressed: true, modifiers: m, .. } => !match key {
            Key::V => paste && m.command && !m.shift,
            Key::X => cut && m.command && !m.shift,
            Key::C => copy && m.command && !m.shift,
            Key::Insert => (paste && m.shift) || (copy && m.command),
            Key::Delete => cut && m.shift,
            _ => false,
        },
        _ => true,
    });
}
