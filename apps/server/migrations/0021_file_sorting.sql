-- A non-null scope prefix supplies index ordering for roots too: PostgreSQL's IS NULL
-- predicate does not establish the ordering equivalence that an equality predicate does.
-- Parent IDs are nonempty; the empty expression value represents only the library root.
-- DESC inverts the folder flag too, keeping every key in one seek direction.
CREATE INDEX hyori_items_sort_name_asc ON hyori_items(coalesce(parent_id,''), owner_id, (kind='file'), lower(name), id) WHERE trashed_at IS NULL;
CREATE INDEX hyori_items_sort_name_desc ON hyori_items(coalesce(parent_id,''), owner_id, (kind='folder') DESC, lower(name) DESC, id DESC) WHERE trashed_at IS NULL;
CREATE INDEX hyori_items_sort_size_asc ON hyori_items(coalesce(parent_id,''), owner_id, (kind='file'), (CASE WHEN kind='folder' THEN 0 ELSE size END), (CASE WHEN kind='folder' THEN lower(name) ELSE '' END), id) WHERE trashed_at IS NULL;
CREATE INDEX hyori_items_sort_size_desc ON hyori_items(coalesce(parent_id,''), owner_id, (kind='folder') DESC, (CASE WHEN kind='folder' THEN 0 ELSE size END) DESC, (CASE WHEN kind='folder' THEN lower(name) ELSE '' END) DESC, id DESC) WHERE trashed_at IS NULL;
CREATE INDEX hyori_items_sort_modified_asc ON hyori_items(coalesce(parent_id,''), owner_id, (kind='file'), updated_at, id) WHERE trashed_at IS NULL;
CREATE INDEX hyori_items_sort_modified_desc ON hyori_items(coalesce(parent_id,''), owner_id, (kind='folder') DESC, updated_at DESC, id DESC) WHERE trashed_at IS NULL;
