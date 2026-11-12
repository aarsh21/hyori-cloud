-- Trash retention claims the oldest trash roots first.
CREATE INDEX hyori_items_trash_age ON hyori_items(trashed_at, id) WHERE trashed_at IS NOT NULL AND trash_root = id;
-- Permanent subtree deletion removes shares set-wise and then cascades per item; the existing
-- share indexes are partial (unrevoked only) and cannot serve those foreign-key lookups.
CREATE INDEX hyori_shares_item_all ON hyori_shares(item_id);
