-- Existing ready rows already satisfy the stricter 256px check. NOT VALID avoids scanning or
-- rewriting the library while enforcing the relaxed bound for every new/updated row.
-- Fail startup rather than queue an unbounded exclusive lock behind a long transaction.
SET LOCAL lock_timeout = '2s';
ALTER TABLE hyori_media_artifacts
    DROP CONSTRAINT hyori_media_artifacts_check,
    ADD CONSTRAINT hyori_media_artifacts_geometry CHECK (
        state <> 'ready' OR (
            size BETWEEN 1 AND 262144 AND
            width BETWEEN 1 AND 384 AND height BETWEEN 1 AND 384
        )
    ) NOT VALID;
-- db::begin sets 5s for the shared migration transaction; later migrations must retain it.
SET LOCAL lock_timeout = '5s';
