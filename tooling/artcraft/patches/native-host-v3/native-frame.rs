use std::cell::RefCell;
use std::rc::Rc;

mod clock;
use clock::NativeHostClock;

#[derive(Default)]
struct IntentQueue {
    sequence: u64,
    opened: bool,
    pending: bool,
    queued: Option<(String, NativeHostIntent)>,
}

struct Confirmation {
    before: Option<NativeHostIdentity>,
    before_revision: u64,
    post_revision: u64,
    applied: bool,
    cancelled: bool,
}

struct Captured {
    request_id: String,
    open_id: String,
    revision: u64,
    save_as: bool,
    intent_id: Option<String>,
    snapshot: NativeHostSnapshot,
    confirmation: Option<Confirmation>,
}

struct ThemeApplication {
    request_id: String,
    preference: String,
    resolved_dark: bool,
}

/// Shared protocol owner for one actual native web application, not an emulated editor.
pub struct NativeHostFrame {
    clock: NativeHostClock,
    intents: Rc<RefCell<IntentQueue>>,
    _repaint: Closure<dyn FnMut()>,
    opening: Option<String>,
    pending: Option<Captured>,
    host_dirty: bool,
    theme: Option<ThemeApplication>,
    system_theme: bool,
    last_system_dark: Option<bool>,
    input_pending: bool,
}

impl NativeHostFrame {
    pub fn prepare(app: &str, version: &str) -> Result<bool, NativeHostFailure> {
        js_prepare(app, version).map_err(js_failure)
    }

    pub fn new(ctx: &egui::Context, app: &mut impl NativeHostAdapter) -> Result<Option<Self>, NativeHostFailure> {
        if !js_requested() { return Ok(None) }
        let repaint_ctx = ctx.clone();
        let repaint = Closure::<dyn FnMut()>::new(move || repaint_ctx.request_repaint());
        js_attach_repaint(repaint.as_ref().unchecked_ref()).map_err(js_failure)?;
        let intents = Rc::new(RefCell::new(IntentQueue::default()));
        let sink = intents.clone();
        let sink_ctx = ctx.clone();
        app.host_install_intents(Box::new(move |intent| {
            let mut queue = sink.try_borrow_mut().map_err(|_| NativeHostFailure::Busy("Native intent queue is in use".into()))?;
            if !queue.opened { return Err(NativeHostFailure::Busy("Wait for the native document to open".into())) }
            // Unsupported explicit exports keep their existing local pipeline and exact options.
            // Replacement NEVER falls through to a local download or optimistic native clean.
            if intent.save_as {
                let name = intent.name.as_deref().ok_or_else(|| NativeHostFailure::SerializationFailed("Explicit export needs a name".into()))?;
                if !js_can_export(name).map_err(js_failure)? { return Ok(None) }
            }
            // A plain replacement during an in-flight save is not an error the user can act on:
            // publish_intent hands it to the host, which coalesces it or quietly cancels the job.
            if queue.queued.is_some() || (intent.save_as && (queue.pending || js_has_pending_save().map_err(js_failure)?)) {
                return Err(NativeHostFailure::Busy("A native save is already pending".into()));
            }
            queue.sequence = queue.sequence.checked_add(1).ok_or_else(|| NativeHostFailure::SerializationFailed("Native intent sequence exhausted".into()))?;
            let id = format!("{}:{}", intent.document_id, queue.sequence);
            queue.queued = Some((id.clone(), intent));
            sink_ctx.request_repaint();
            Ok(Some(id))
        }));
        Ok(Some(Self { clock: NativeHostClock::default(), intents, _repaint: repaint,
            opening: None, pending: None, host_dirty: false, theme: None,
            system_theme: false, last_system_dark: None, input_pending: false }))
    }

    pub fn ready() -> Result<(), NativeHostFailure> {
        if js_requested() { js_ready().map_err(js_failure)?; }
        Ok(())
    }

    pub fn failed(message: &str) -> Result<(), NativeHostFailure> {
        if js_requested() { js_failed(message).map_err(js_failure)?; }
        Ok(())
    }

    pub fn note_input(&mut self, app: &impl NativeHostAdapter, raw: &egui::RawInput) -> Result<(), NativeHostFailure> {
        // Manual settling must never consume a live editor before UI applies this input batch.
        // Retain the fence across discarded passes and hidden logic-only ticks.
        self.input_pending |= !raw.events.is_empty() || !raw.dropped_files.is_empty();
        self.clock.note_input(raw, app.host_pending_input())
    }

    fn revision(&mut self, app: &impl NativeHostAdapter) -> Result<u64, NativeHostFailure> {
        let model = app.host_identity();
        // Do not latch ordinary draft dirtiness: cancelling an uncaptured draft must emit false.
        // Only an outstanding replacement capture creates a durability overlay (see capture).
        self.clock.observe(model, app.host_pending_input(), self.host_dirty)
    }

    fn effective_dirty(&self, app: &impl NativeHostAdapter) -> bool {
        self.host_dirty || app.host_pending_input() || app.host_identity().is_some_and(|model| model.dirty)
    }

    fn observe(&mut self, app: &impl NativeHostAdapter) -> Result<(), NativeHostFailure> {
        let revision = self.revision(app)?;
        if !self.intents.try_borrow().map_err(|_| NativeHostFailure::Busy("Native intent queue is in use".into()))?.opened { return Ok(()) }
        if let Some(model) = app.host_identity() {
            js_observed(&model.document_id.to_string(), &revision.to_string(), self.effective_dirty(app)).map_err(js_failure)?;
        } else {
            js_detached("The native document was closed; reopen a cloud source before replacing it").map_err(js_failure)?;
        }
        Ok(())
    }

    fn opened(&mut self, app: &impl NativeHostAdapter, identity: NativeHostIdentity) -> Result<(), NativeHostFailure> {
        let Some(open_id) = self.opening.as_ref() else { return Err(NativeHostFailure::IdentityChanged) };
        if app.host_identity().map(|model| model.document_id) != Some(identity.document_id) {
            return Err(NativeHostFailure::IdentityChanged);
        }
        self.host_dirty = false;
        let revision = self.clock.observe(Some(identity), app.host_pending_input(), self.host_dirty)?;
        js_opened(open_id, &identity.document_id.to_string(), &revision.to_string()).map_err(js_failure)?;
        self.opening = None;
        self.intents.try_borrow_mut().map_err(|_| NativeHostFailure::Busy("Native intent queue is in use".into()))?.opened = true;
        Ok(())
    }

    fn process_open(&mut self, app: &mut impl NativeHostAdapter) -> Result<(), NativeHostFailure> {
        if self.opening.is_some() { return Ok(()) }
        let command = js_take_open().map_err(js_failure)?;
        if absent(&command) { return Ok(()) }
        let open_id = text(&command, "openId")?;
        let name = text(&command, "name")?;
        let bytes = js_sys::Uint8Array::new(&field(&command, "bytes")?);
        if bytes.length() == 0 || bytes.length() > 64 * 1024 * 1024 {
            return js_open_failed(&open_id, "Native open exceeds its byte bound").map_err(js_failure);
        }
        app.host_annotation_author(optional_text(&command, "annotationAuthor")?.as_deref().unwrap_or("Guest"));
        self.opening = Some(open_id.clone());
        match app.host_open(&name, &bytes.to_vec()) {
            Ok(Some(identity)) => self.opened(app, identity),
            Ok(None) => Ok(()),
            Err(error) => {
                self.opening = None;
                js_open_failed(&open_id, &error.to_string()).map_err(js_failure)
            }
        }
    }

    fn poll_open(&mut self, app: &mut impl NativeHostAdapter) -> Result<(), NativeHostFailure> {
        if self.opening.is_none() { return Ok(()) }
        match app.host_poll_open() {
            Ok(Some(identity)) => self.opened(app, identity),
            Ok(None) => Ok(()),
            Err(error) => {
                let Some(open_id) = self.opening.take() else { return Err(NativeHostFailure::IdentityChanged) };
                js_open_failed(&open_id, &error.to_string()).map_err(js_failure)
            }
        }
    }

    fn fence(&mut self, app: &mut impl NativeHostAdapter, message: &JsValue) -> Result<(), NativeHostFailure> {
        if let Some(id) = optional_text(message, "intentId")? {
            app.host_cancel_intent(&id);
            if let Some(pending) = self.pending.as_mut()
                && pending.intent_id.as_deref() == Some(id.as_str())
                && let Some(confirmation) = pending.confirmation.as_mut()
            { confirmation.cancelled = true; }
        }
        Ok(())
    }

    fn process_fences(&mut self, app: &mut impl NativeHostAdapter) -> Result<(), NativeHostFailure> {
        let cancellation = js_take_cancellation().map_err(js_failure)?;
        if !absent(&cancellation) { self.fence(app, &cancellation)?; }
        let failure = js_take_failure().map_err(js_failure)?;
        if !absent(&failure) { self.fence(app, &failure)?; }
        let discard = js_take_discard().map_err(js_failure)?;
        if !absent(&discard) { self.discard(app, &discard)?; }
        Ok(())
    }

    /// The host kept this snapshot itself and will never persist it. Drop it and its job so a
    /// later capture can run; the live document's dirty state is left exactly as it is.
    fn discard(&mut self, app: &mut impl NativeHostAdapter, message: &JsValue) -> Result<(), NativeHostFailure> {
        let Some(captured) = self.pending.as_ref() else { return Ok(()) };
        if text(message, "requestId")? != captured.request_id || captured.confirmation.is_some() { return Ok(()) }
        let Some(captured) = self.pending.take() else { return Ok(()) };
        self.intents.try_borrow_mut().map_err(|_| NativeHostFailure::Busy("Native intent queue is in use".into()))?.pending = false;
        if let Some(id) = captured.intent_id { app.host_cancel_intent(&id); }
        Ok(())
    }

    fn process_ack(&mut self, app: &mut impl NativeHostAdapter) -> Result<(), NativeHostFailure> {
        let ack = js_take_ack().map_err(js_failure)?;
        if absent(&ack) { return Ok(()) }
        let Some(captured) = self.pending.as_ref() else { return Err(NativeHostFailure::IdentityChanged) };
        if text(&ack, "requestId")? != captured.request_id
            || text(&ack, "openId")? != captured.open_id
            || native_number(&ack, "documentId")? != captured.snapshot.identity.document_id
            || native_number(&ack, "revision")? != captured.revision
        { return Err(NativeHostFailure::IdentityChanged) }

        if captured.confirmation.is_none() {
            let before = app.host_identity();
            let before_revision = self.revision(app)?;
            let Some(captured) = self.pending.as_ref() else { return Err(NativeHostFailure::IdentityChanged) };
            let exact = before_revision == captured.revision
                && before.is_some_and(|model| model.same_snapshot(captured.snapshot.identity))
                && !app.host_pending_input();
            let cancelled = boolean(&ack, "continuationCancelled")?;
            let result = if exact && !captured.save_as {
                app.host_acknowledge(&captured.snapshot, false)
            } else { Ok(false) };
            let applied = matches!(result, Ok(true));
            if applied { self.host_dirty = false; }
            if exact && !captured.save_as && !applied {
                self.clock.invalidate()?;
                self.host_dirty = true;
            }
            let post_revision = self.revision(app)?;
            let Some(captured) = self.pending.as_mut() else { return Err(NativeHostFailure::IdentityChanged) };
            captured.confirmation = Some(Confirmation { before, before_revision, post_revision, applied, cancelled });
            // Do not retry PDF mark_saved after partial/native failure. An explicit confirmation
            // retry reports current dirty state, without applying the captured graph a second time.
            result?;
        }
        self.confirm(app)
    }

    fn confirm(&mut self, app: &mut impl NativeHostAdapter) -> Result<(), NativeHostFailure> {
        let current_revision = self.revision(app)?;
        let current = app.host_identity();
        let dirty = self.effective_dirty(app);
        let Some(captured) = self.pending.as_ref() else { return Err(NativeHostFailure::IdentityChanged) };
        let Some(confirmation) = captured.confirmation.as_ref() else { return Err(NativeHostFailure::IdentityChanged) };
        js_acknowledged(&document_value(confirmation.before), &confirmation.before_revision.to_string(),
            &document_value(current), &current_revision.to_string(), dirty).map_err(js_failure)?;
        let continue_action = confirmation.applied && !confirmation.cancelled
            && !captured.save_as && confirmation.post_revision == current_revision && !dirty;
        let intent_id = captured.intent_id.clone();
        self.pending = None;
        self.intents.try_borrow_mut().map_err(|_| NativeHostFailure::Busy("Native intent queue is in use".into()))?.pending = false;
        if let Some(id) = intent_id { app.host_finish_intent(&id, continue_action); }
        Ok(())
    }

    fn process_capture(&mut self, app: &mut impl NativeHostAdapter) -> Result<(), NativeHostFailure> {
        if self.pending.is_some() || self.opening.is_some() { return Ok(()) }
        let command = js_take_save_request().map_err(js_failure)?;
        if absent(&command) { return Ok(()) }
        let request_id = text(&command, "requestId")?;
        let open_id = text(&command, "openId")?;
        let document_id = native_number(&command, "documentId")?;
        let name = text(&command, "name")?;
        let intent_id = optional_text(&command, "intentId")?;
        let save_as = boolean(&command, "saveAs")?;
        let reason = match text(&command, "reason")?.as_str() {
            "manual" => NativeHostSaveReason::Manual,
            "automatic" => NativeHostSaveReason::Automatic,
            _ => return Err(NativeHostFailure::SerializationFailed("Invalid capture reason".into())),
        };
        let snapshot = match app.host_capture(document_id, &name, reason, intent_id.as_deref()) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                if let Some(id) = intent_id { app.host_cancel_intent(&id); }
                js_serialization_failed(&request_id, error.code(), &error.to_string()).map_err(js_failure)?;
                return Ok(());
            }
        };
        if snapshot.identity.document_id != document_id || snapshot.name != name
            || snapshot.bytes.is_empty() || snapshot.bytes.len() > 64 * 1024 * 1024
        {
            if let Some(id) = intent_id { app.host_cancel_intent(&id); }
            js_serialization_failed(&request_id, "serialization-failed", "Native capture differs from its authorized document, name or byte bound").map_err(js_failure)?;
            return Ok(());
        }
        // Undo may return to the OLD native baseline while this captured edit becomes the NEW
        // server baseline. Keep replacement work dirty until exact acknowledgement reconciles it.
        self.host_dirty |= !save_as && snapshot.identity.dirty;
        let revision = self.revision(app)?;
        self.observe(app)?;
        self.pending = Some(Captured { request_id, open_id, revision, save_as, intent_id,
            snapshot, confirmation: None });
        self.intents.try_borrow_mut().map_err(|_| NativeHostFailure::Busy("Native intent queue is in use".into()))?.pending = true;
        let Some(captured) = self.pending.as_ref() else { return Err(NativeHostFailure::IdentityChanged) };
        // Store Rust recovery before posting. A failed post must not discard this snapshot/job.
        let result = js_serialized(&captured.request_id, &document_id.to_string(), &revision.to_string(),
            &captured.snapshot.name, &captured.snapshot.bytes, save_as);
        if let Err(error) = result {
            let error = js_failure(error);
            if !js_has_recovery_snapshot().map_err(js_failure)? {
                // Rejected before publication: no uncertain write exists. Keep the live native
                // document dirty, release only this invalid output and report its capture failure.
                let rejected = self.pending.take().ok_or(NativeHostFailure::IdentityChanged)?;
                self.intents.try_borrow_mut().map_err(|_| NativeHostFailure::Busy("Native intent queue is in use".into()))?.pending = false;
                if let Some(id) = rejected.intent_id { app.host_cancel_intent(&id); }
                js_serialization_failed(&rejected.request_id, error.code(), &error.to_string()).map_err(js_failure)?;
                return Ok(());
            }
            return Err(error);
        }
        Ok(())
    }

    fn publish_intent(&mut self, app: &mut impl NativeHostAdapter) -> Result<(), NativeHostFailure> {
        let intent = self.intents.try_borrow_mut().map_err(|_| NativeHostFailure::Busy("Native intent queue is in use".into()))?.queued.take();
        let Some((id, intent)) = intent else { return Ok(()) };
        let name = intent.name.as_deref().map(JsValue::from_str).unwrap_or(JsValue::UNDEFINED);
        match js_save_requested(&intent.document_id.to_string(), intent.save_as, &name, &id) {
            Ok(true) => Ok(()),
            Ok(false) => { app.host_cancel_intent(&id); Ok(()) }
            Err(error) => { app.host_cancel_intent(&id); Err(js_failure(error)) }
        }
    }

    fn process_theme(&mut self, app: &mut impl NativeHostAdapter) -> Result<(), NativeHostFailure> {
        let command = js_take_theme().map_err(js_failure)?;
        let system_dark = js_system_dark().map_err(js_failure)?;
        if !absent(&command) {
            let preference = text(&command, "theme")?;
            let resolved_dark = match preference.as_str() { "dark" => true, "light" => false, "system" => system_dark,
                _ => return Err(NativeHostFailure::SerializationFailed("Unknown native theme".into())) };
            let request_id = text(&command, "requestId")?;
            if let Err(error) = app.host_theme(&preference, resolved_dark) {
                return js_theme_failed(&request_id, &error.to_string()).map_err(js_failure);
            }
            self.system_theme = preference == "system";
            self.last_system_dark = Some(system_dark);
            self.theme = Some(ThemeApplication { request_id, preference, resolved_dark });
        } else if self.system_theme && self.last_system_dark != Some(system_dark) {
            app.host_theme("system", system_dark)?;
            self.last_system_dark = Some(system_dark);
            if let Some(theme) = self.theme.as_mut() { theme.resolved_dark = system_dark; }
        }
        Ok(())
    }

    pub fn before_logic(&mut self, app: &mut impl NativeHostAdapter, _ctx: &egui::Context) -> Result<(), NativeHostFailure> {
        self.process_fences(app)?;
        self.process_ack(app)?;
        self.process_open(app)?;
        self.process_theme(app)
    }

    pub fn after_logic(&mut self, app: &mut impl NativeHostAdapter, ctx: &egui::Context) -> Result<(), NativeHostFailure> {
        guard_urls(ctx);
        self.poll_open(app)?;
        self.observe(app)?;
        if self.input_pending { return Ok(()) }
        self.process_capture(app)
    }

    pub fn after_ui(&mut self, app: &mut impl NativeHostAdapter, ctx: &egui::Context) -> Result<(), NativeHostFailure> {
        guard_urls(ctx);
        if ctx.will_discard() { return Ok(()) }
        self.input_pending = false;
        self.poll_open(app)?;
        self.observe(app)?;
        self.publish_intent(app)?;
        let was_pending = self.pending.is_some();
        self.process_capture(app)?;
        if !was_pending && self.pending.is_some() { ctx.request_repaint(); }
        if let Some(theme) = self.theme.as_ref()
            && ctx.global_style().visuals.dark_mode == theme.resolved_dark
        {
            js_theme_applied(&theme.request_id, &theme.preference, if theme.resolved_dark { "dark" } else { "light" }).map_err(js_failure)?;
            self.theme = None;
        }
        Ok(())
    }
}

/// Document links run with Hyori's origin, so a crafted `javascript:` or `data:` link must never
/// reach the browser. Only absolute web and mail links open, always in a new, unrelated tab.
fn guard_urls(ctx: &egui::Context) {
    let urls: Vec<String> = ctx.output_mut(|output| {
        let mut urls = Vec::new();
        output.commands.retain(|command| match command {
            egui::OutputCommand::OpenUrl(open) => { urls.push(open.url.clone()); false }
            _ => true,
        });
        urls
    });
    for url in urls {
        if let Some(url) = allowed_url(&url)
            && let Some(window) = eframe::web_sys::window()
        {
            let _ = window.open_with_url_and_target_and_features(&url, "_blank", "noopener,noreferrer");
        }
    }
}

/// Browsers drop leading C0/space and every tab/newline before reading a scheme; do the same.
fn allowed_url(url: &str) -> Option<String> {
    let url: String = url.trim_start_matches(|c: char| c <= ' ').chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let (scheme, _) = url.split_once(':')?;
    matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https" | "mailto").then_some(url)
}
