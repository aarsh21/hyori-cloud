-- A trash root's historical location is display-only. The live parent ID still controls restore.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='120s';
ALTER TABLE hyori_items ADD COLUMN original_parent_path jsonb;

CREATE FUNCTION hyori_item_parent_names(item_owner text, ancestors jsonb) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT coalesce(jsonb_agg(parent.name ORDER BY path.position), '[]'::jsonb)
    FROM jsonb_array_elements_text(ancestors) WITH ORDINALITY AS path(id, position)
    JOIN hyori_items parent ON parent.id = path.id AND parent.owner_id = item_owner;
$$;

-- Older entries did not record deletion-time names. Backfill from the retained tree once.
UPDATE hyori_items SET original_parent_path = hyori_item_parent_names(owner_id, ancestor_ids)
WHERE trashed_at IS NOT NULL AND trash_root = id;

CREATE FUNCTION hyori_snapshot_trash_path() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.trashed_at IS NULL THEN
        NEW.original_parent_path := NULL;
    ELSE
        NEW.original_parent_path := hyori_item_parent_names(OLD.owner_id, OLD.ancestor_ids);
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER hyori_item_trash_path BEFORE UPDATE OF trashed_at ON hyori_items
FOR EACH ROW WHEN (
    (OLD.trashed_at IS NULL) <> (NEW.trashed_at IS NULL)
    AND (OLD.trash_root = OLD.id OR NEW.trash_root = NEW.id)
) EXECUTE FUNCTION hyori_snapshot_trash_path();

-- Store one count per nonempty parent (a count can later reach zero). Keep the counter off the
-- item row so it does not rewrite folder metadata, sorting indexes, or the folder revision.
CREATE TABLE hyori_item_child_counts (
    parent_id text PRIMARY KEY REFERENCES hyori_items(id) ON DELETE CASCADE,
    child_count bigint NOT NULL CHECK (child_count BETWEEN 0 AND 9007199254740991)
);

INSERT INTO hyori_item_child_counts (parent_id, child_count)
SELECT parent_id, count(*) FROM hyori_items
WHERE parent_id IS NOT NULL AND trashed_at IS NULL GROUP BY parent_id;

-- Statement-level transition tables collapse uploads and subtree trash/restore into net changes
-- per direct parent. Renames, revisions, and ancestry-only rewrites leave counts untouched.
CREATE FUNCTION hyori_update_item_child_counts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO hyori_item_child_counts AS c (parent_id, child_count)
        SELECT parent_id, count(*) FROM new_items
        WHERE parent_id IS NOT NULL AND trashed_at IS NULL GROUP BY parent_id ORDER BY parent_id
        ON CONFLICT (parent_id) DO UPDATE SET child_count = c.child_count + EXCLUDED.child_count;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE hyori_item_child_counts c SET child_count = c.child_count - removed.n
        FROM (SELECT parent_id, count(*) AS n FROM old_items
              WHERE parent_id IS NOT NULL AND trashed_at IS NULL GROUP BY parent_id) removed
        WHERE c.parent_id = removed.parent_id;
    ELSE
        WITH deltas AS (
            SELECT parent_id, sum(n)::bigint AS n FROM (
                SELECT parent_id, -count(*) AS n FROM old_items
                WHERE parent_id IS NOT NULL AND trashed_at IS NULL GROUP BY parent_id
                UNION ALL
                SELECT parent_id, count(*) AS n FROM new_items
                WHERE parent_id IS NOT NULL AND trashed_at IS NULL GROUP BY parent_id
            ) edges GROUP BY parent_id
        ), decremented AS (
            UPDATE hyori_item_child_counts c SET child_count = c.child_count + d.n
            FROM deltas d WHERE c.parent_id = d.parent_id AND d.n < 0
        )
        INSERT INTO hyori_item_child_counts AS c (parent_id, child_count)
        SELECT parent_id, n FROM deltas WHERE n > 0 ORDER BY parent_id
        ON CONFLICT (parent_id) DO UPDATE SET child_count = c.child_count + EXCLUDED.child_count;
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER hyori_item_children_insert AFTER INSERT ON hyori_items
REFERENCING NEW TABLE AS new_items FOR EACH STATEMENT EXECUTE FUNCTION hyori_update_item_child_counts();
CREATE TRIGGER hyori_item_children_update AFTER UPDATE ON hyori_items
REFERENCING OLD TABLE AS old_items NEW TABLE AS new_items FOR EACH STATEMENT EXECUTE FUNCTION hyori_update_item_child_counts();
CREATE TRIGGER hyori_item_children_delete AFTER DELETE ON hyori_items
REFERENCING OLD TABLE AS old_items FOR EACH STATEMENT EXECUTE FUNCTION hyori_update_item_child_counts();

SET LOCAL statement_timeout='10s';
SET LOCAL lock_timeout='5s';
