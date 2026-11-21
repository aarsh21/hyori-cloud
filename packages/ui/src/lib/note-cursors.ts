import { createExtension, type ExtensionOptions } from "@blocknote/core";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "y-prosemirror";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

type NoteCursorOptions = {
  awareness: Awareness;
  holdRemoteChanges?: (() => () => void) | undefined;
};

type Point = { left: number; top: number; bottom: number };

type Peer = { name: string; color: string; head: number; from: number; to: number };

type Drawn = {
  root: HTMLElement;
  caret: HTMLElement;
  label: HTMLElement;
  hide?: number;
  hovered?: boolean;
};

/**
 * Collaboration cursors for the note editor. y-prosemirror draws remote carets as widget
 * decorations inside the contenteditable, so every peer caret move rebuilds DOM next to the local
 * caret, and the browser can drop or misplace a keystroke or IME composition typed into that
 * rebuild. Here remote carets and selections live in an overlay beside the editable DOM: peer
 * presence never touches the nodes a person is typing into, and never dispatches an editor
 * transaction. The local caret is published to awareness in the same relative-position format.
 *
 * While a composition is open, `holdRemoteChanges` keeps peers' content from replacing the
 * paragraph being composed; their edits land together once it commits.
 */
export const NoteCursorsExtension = createExtension(
  ({ editor, options }: ExtensionOptions<NoteCursorOptions>) => ({
    key: "hyoriNoteCursors",
    mount({ dom, signal }: { dom: HTMLElement; signal: AbortSignal }) {
      const { awareness, holdRemoteChanges } = options;
      const view = editor.prosemirrorView!;
      const container = (dom.closest(".hyori-note-editor") ?? dom.parentElement)!;
      const layer = document.createElement("div");
      layer.className = "hyori-note-cursors";
      layer.setAttribute("aria-hidden", "true");
      container.append(layer);
      const drawn = new Map<number, Drawn>();
      const selections = document.createElement("div");
      layer.append(selections);
      let frame = 0;

      function binding() {
        const state = ySyncPluginKey.getState(view.state);

        return state && state.binding.mapping.size > 0 ? state : null;
      }

      function publish() {
        const state = binding();

        if (!state) return;
        const current = awareness.getLocalState()?.cursor;

        if (!view.hasFocus()) {
          if (current != null) awareness.setLocalStateField("cursor", null);

          return;
        }

        const { anchor, head } = view.state.selection;

        const relative = (pos: number) =>
          absolutePositionToRelativePosition(pos, state.type, state.binding.mapping);

        const next = { anchor: relative(anchor), head: relative(head) };

        if (
          current == null ||
          !Y.compareRelativePositions(
            Y.createRelativePositionFromJSON(current.anchor),
            next.anchor,
          ) ||
          !Y.compareRelativePositions(Y.createRelativePositionFromJSON(current.head), next.head)
        )
          awareness.setLocalStateField("cursor", next);
      }

      function peers() {
        const state = binding();
        const found = new Map<number, Peer>();

        if (!state) return found;
        const max = Math.max(view.state.doc.content.size - 1, 0);

        const absolute = (position: Parameters<typeof Y.createRelativePositionFromJSON>[0]) =>
          relativePositionToAbsolutePosition(
            state.doc,
            state.type,
            Y.createRelativePositionFromJSON(position),
            state.binding.mapping,
          );

        awareness.getStates().forEach((value, clientId) => {
          if (clientId === awareness.clientID || value.cursor == null) return;
          const anchor = absolute(value.cursor.anchor);
          const head = absolute(value.cursor.head);

          if (anchor === null || head === null) return;
          const [a, h] = [Math.min(anchor, max), Math.min(head, max)];
          found.set(clientId, {
            name: String(value.user?.name ?? "Someone"),
            color: /^#[0-9a-f]{6}$/i.test(value.user?.color) ? value.user.color : "#a1a1aa",
            head: h,
            from: Math.min(a, h),
            to: Math.max(a, h),
          });
        });

        return found;
      }

      function point(pos: number): Point | null {
        try {
          return view.coordsAtPos(pos);
        } catch {
          return null;
        }
      }

      function cursor(clientId: number, peer: Peer) {
        let entry = drawn.get(clientId);

        if (!entry) {
          const root = document.createElement("span");
          root.className = "hyori-note-cursor bn-collaboration-cursor__base";
          const caret = document.createElement("span");
          caret.className = "bn-collaboration-cursor__caret";
          const label = document.createElement("span");
          label.className = "bn-collaboration-cursor__label";
          caret.append(label);
          root.append(caret);
          layer.append(root);
          entry = { root, caret, label };
          drawn.set(clientId, entry);
        }

        if (entry.label.textContent !== peer.name) entry.label.textContent = peer.name;
        entry.root.style.setProperty("--cursor-color", peer.color);

        return entry;
      }

      // A caret that moved shows its name briefly, the way BlockNote's activity labels do.
      function activity(entry: Drawn) {
        clearTimeout(entry.hide);
        entry.root.dataset.active = "";

        // A caret under the pointer keeps its name until the pointer leaves it.
        if (!entry.hovered)
          entry.hide = window.setTimeout(() => delete entry.root.dataset.active, 2000);
      }

      function render() {
        frame = 0;
        const origin = container.getBoundingClientRect();
        const found = peers();
        const highlight: HTMLElement[] = [];

        for (const [clientId, entry] of drawn) {
          if (found.has(clientId)) continue;
          clearTimeout(entry.hide);
          entry.root.remove();
          drawn.delete(clientId);
        }

        for (const [clientId, peer] of found) {
          const at = point(peer.head);
          const entry = cursor(clientId, peer);

          if (!at) {
            entry.root.hidden = true;
            continue;
          }

          const place = `${Math.round(at.left - origin.left)}px,${Math.round(at.top - origin.top)}px`;

          if (entry.root.dataset.place !== place) {
            if (entry.root.dataset.place !== undefined) activity(entry);
            entry.root.dataset.place = place;
            entry.root.style.transform = `translate(${place})`;
          }

          entry.root.hidden = false;
          entry.caret.style.height = `${Math.max(at.bottom - at.top, 1)}px`;

          if (peer.from === peer.to) continue;

          try {
            const range = document.createRange();
            const start = view.domAtPos(peer.from);
            const end = view.domAtPos(peer.to);
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset);

            for (const rect of range.getClientRects()) {
              const box = document.createElement("span");
              box.className = "hyori-note-selection";
              box.style.cssText = `transform:translate(${rect.left - origin.left}px,${rect.top - origin.top}px);width:${rect.width}px;height:${rect.height}px;background:${peer.color}40`;
              highlight.push(box);
            }
          } catch {
            /* A selection the view cannot map yet is drawn on the next frame. */
          }
        }

        selections.replaceChildren(...highlight);
      }

      function schedule() {
        if (frame === 0 && !signal.aborted) frame = requestAnimationFrame(render);
      }

      let release: (() => void) | undefined;
      let releasing: number | undefined;

      function compose() {
        clearTimeout(releasing);
        release ??= holdRemoteChanges?.();
      }

      // ProseMirror reads the committed composition a moment after compositionend.
      function commit() {
        clearTimeout(releasing);
        releasing = window.setTimeout(() => {
          release?.();
          release = undefined;
        }, 50);
      }

      const observer = new ResizeObserver(schedule);
      observer.observe(dom);
      // A web font arriving moves glyphs without resizing the editor, which would strand carets.
      document.fonts.addEventListener("loadingdone", schedule);
      void document.fonts.ready.then(schedule);
      const stopChange = editor.onChange(schedule, true);

      const stopSelection = editor.onSelectionChange(() => {
        publish();
        schedule();
      }, true);

      const onFocus = () => publish();

      // The overlay never takes the pointer, so a click on a peer's caret still places the local
      // one. Hovering near a caret shows its name, read from pointer moves over the editor.
      function hover(event: PointerEvent) {
        for (const entry of drawn.values()) {
          const box = entry.caret.getBoundingClientRect();

          const near =
            !entry.root.hidden &&
            event.clientY >= box.top &&
            event.clientY <= box.bottom &&
            Math.abs(event.clientX - box.left) <= 4;

          const was = entry.hovered;
          entry.hovered = near;

          // Showing is idempotent, so a missed pointerleave can never leave a name unreachable.
          if (near) {
            clearTimeout(entry.hide);
            entry.root.dataset.active = "";
          } else if (was) activity(entry);
        }
      }

      function leave() {
        for (const entry of drawn.values()) {
          if (!entry.hovered) continue;
          entry.hovered = false;
          activity(entry);
        }
      }

      awareness.on("change", schedule);
      dom.addEventListener("focusin", onFocus);
      dom.addEventListener("pointermove", hover);
      dom.addEventListener("pointerleave", leave);
      dom.addEventListener("focusout", onFocus);
      dom.addEventListener("compositionstart", compose);
      dom.addEventListener("compositionend", commit);
      dom.addEventListener("focusout", commit);
      publish();
      schedule();

      return () => {
        cancelAnimationFrame(frame);
        clearTimeout(releasing);
        release?.();
        observer.disconnect();
        document.fonts.removeEventListener("loadingdone", schedule);
        stopChange();
        stopSelection();
        awareness.off("change", schedule);
        dom.removeEventListener("focusin", onFocus);
        dom.removeEventListener("focusout", onFocus);
        dom.removeEventListener("pointermove", hover);
        dom.removeEventListener("pointerleave", leave);
        dom.removeEventListener("compositionstart", compose);
        dom.removeEventListener("compositionend", commit);
        dom.removeEventListener("focusout", commit);

        for (const entry of drawn.values()) clearTimeout(entry.hide);
        layer.remove();

        if (awareness.getLocalState()?.cursor != null) awareness.setLocalStateField("cursor", null);
      };
    },
  }),
);
