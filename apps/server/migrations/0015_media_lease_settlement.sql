-- Without a decoder, maintenance still settles expired worker leases in lease order.
CREATE INDEX hyori_media_jobs_expired_leases ON hyori_media_jobs(lease_until, id) WHERE state = 'processing';
-- A job the claim set aside because its source was only in Trash; restore makes it due again.
ALTER TABLE hyori_media_jobs ADD COLUMN deferred boolean NOT NULL DEFAULT false;
