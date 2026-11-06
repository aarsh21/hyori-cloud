-- A bounded admission projection avoids reading every other live upload during reservation.
-- The reservation flag remains authoritative; its transition and the counter commit together.
ALTER TABLE hyori_users ADD COLUMN pending_uploads integer NOT NULL DEFAULT 0
    CHECK (pending_uploads BETWEEN 0 AND 128);

UPDATE hyori_users AS u SET pending_uploads = (
    SELECT count(*)::integer FROM hyori_uploads AS p
    WHERE p.owner_id = u.id AND p.reservation_held
);

CREATE FUNCTION hyori_track_upload_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    owner text;
    change integer;
BEGIN
    IF TG_OP = 'INSERT' THEN
        owner := NEW.owner_id;
        change := CASE WHEN NEW.reservation_held THEN 1 ELSE 0 END;
    ELSIF TG_OP = 'DELETE' THEN
        owner := OLD.owner_id;
        change := CASE WHEN OLD.reservation_held THEN -1 ELSE 0 END;
    ELSE
        IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
            RAISE EXCEPTION 'Upload ownership is immutable' USING ERRCODE = '23514';
        END IF;
        owner := NEW.owner_id;
        change := (CASE WHEN NEW.reservation_held THEN 1 ELSE 0 END)
                - (CASE WHEN OLD.reservation_held THEN 1 ELSE 0 END);
    END IF;

    IF change <> 0 THEN
        UPDATE hyori_users SET pending_uploads = pending_uploads + change WHERE id = owner;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER hyori_upload_admission
AFTER INSERT OR DELETE OR UPDATE OF reservation_held, owner_id ON hyori_uploads
FOR EACH ROW EXECUTE FUNCTION hyori_track_upload_admission();
