-- Ceilings across clients and emails (100 logins per client address, 100 guesses per secret from
-- all clients) count past the 11 attempts the first schema allowed, where the 12th attempt failed
-- this check and answered 503 instead of counting. Counters stop one past the largest limit.
ALTER TABLE hyori_rate_limits DROP CONSTRAINT hyori_rate_limits_attempts_check;
ALTER TABLE hyori_rate_limits ADD CONSTRAINT hyori_rate_limits_attempts_check CHECK (attempts BETWEEN 1 AND 1000);
