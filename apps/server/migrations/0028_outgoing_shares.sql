CREATE INDEX hyori_shares_outgoing ON hyori_shares (issuer_id, created_at DESC, id DESC)
    WHERE revoked_at IS NULL;
