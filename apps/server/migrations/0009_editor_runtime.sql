-- A verified, explicit runtime configuration activates each app once. Later disable choices survive restart.
ALTER TABLE hyori_editor_assets ADD COLUMN first_activated_catalog_sha256 text;
-- The old modified Deck remains retained evidence, never relabelled as the shipping artifact.
-- Existing disable state is preserved; a missing verified catalogue always denies runtime capability.
UPDATE hyori_editor_assets SET version='0.14.1-hyori-host.2' WHERE app='deckcraft' AND version='0.14.1-hyori-host.1';
