-- Omitted legacy requests retain their original fingerprint and manual history semantics.
ALTER TABLE hyori_editor_saves
    ADD COLUMN save_mode text NOT NULL DEFAULT 'manual'
    CHECK (save_mode IN ('manual', 'automatic')),
    ADD CONSTRAINT hyori_editor_automatic_replace CHECK (save_mode <> 'automatic' OR intent = 'replace');
