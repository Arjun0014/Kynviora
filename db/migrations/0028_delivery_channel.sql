-- 0028_delivery_channel.sql
-- Recording which channel a delivery actually took (`DEV-033`, `04` Phase 7.5, DEC-119).
--
-- Spec references: `04` Phase 7.5 (channel policy, digest policy for lower urgency,
-- deduplication), `20` (an operator can reconstruct why something did or did not reach a device,
-- from counts and codes rather than content), `16`, `0014`, `0024`.
--
-- WHAT WAS MISSING, AND WHY IT MATTERS BEYOND THE DIGEST
-- `deliveryDecision` has decided a channel per recipient since DEC-119, and `dispatchAlert` acted
-- on that decision and then threw it away. The row said a delivery happened; it did not say
-- whether anything reached a device, and the only surviving trace was a **profile-level** summary
-- inside an `audit_event` detail blob - one channel for a dispatch that may have made six
-- different decisions, because two recipients can be in two time zones.
--
-- So the question "why was I not notified?" had no answer at the granularity it is asked at. That
-- is worth fixing on its own. It is also the exact thing `DEV-033` needs: a digest is assembled
-- from the rows that were *planned onto the digest channel*, and nothing recorded which those
-- were.
--
-- WHY NULLABLE, WHEN EVERY NEW ROW WILL HAVE ONE
-- Because rows written before this migration took a channel nobody wrote down, and there is no
-- honest value to backfill them with. `IN_APP_ONLY` would be a guess that reads as a fact, and a
-- default is exactly how a guess becomes one. NULL means "written before the channel was
-- recorded", the three columns are absent together, and any reader looking for digest material
-- asks for `channel = 'DIGEST'` - which excludes them without having to know why.
--
-- WHAT THE CONSTRAINTS ARE FOR
-- Two of them restate an invariant that currently lives only in `deliveryDecision`'s control flow:
-- **only an interrupt can be held.** Nothing quieter has a time it would otherwise have arrived,
-- so holding one is meaningless - and a held digest line would be a lower urgency wearing the
-- language of a deferred alert. Putting it in the schema means a future change to that function
-- has to come back here and say so.

ALTER TABLE alert_delivery
  -- Which channel this recipient's copy took. `DIGEST` is the one that has somewhere to go later.
  ADD COLUMN channel        text,
  -- Why. Reported on every decision rather than only on refusals, which is what makes "nothing
  -- was sent because the urgency was informational" distinguishable from a push that failed.
  ADD COLUMN channel_reason text,
  -- Whether this was held rather than sent now. Held is not downgraded: a HIGH alert held for
  -- quiet hours is still a HIGH alert and is still an interrupt when the window ends.
  ADD COLUMN held           boolean;

ALTER TABLE alert_delivery
  ADD CONSTRAINT alert_delivery_channel_valid
    CHECK (channel IS NULL OR channel IN ('INTERRUPT', 'DIGEST', 'IN_APP_ONLY')),

  ADD CONSTRAINT alert_delivery_channel_reason_valid
    CHECK (channel_reason IS NULL OR channel_reason IN (
      'URGENCY_CEILING', 'HELD_FOR_QUIET_HOURS', 'PIERCED_QUIET_HOURS',
      'ALERT_NOT_DELIVERABLE', 'ALREADY_DELIVERED'
    )),

  -- All three or none. A row with a channel and no reason would be one that recorded the decision
  -- and lost the half an operator actually reads.
  ADD CONSTRAINT alert_delivery_channel_together
    CHECK (
      (channel IS NULL AND channel_reason IS NULL AND held IS NULL)
      OR (channel IS NOT NULL AND channel_reason IS NOT NULL AND held IS NOT NULL)
    ),

  -- Only an interrupt can be held, and a hold has exactly one reason. Both come straight from
  -- `deliveryDecision`, where they are properties of which branch returned - true, and true only
  -- for as long as nobody edits that function without reading it.
  ADD CONSTRAINT alert_delivery_held_is_an_interrupt
    CHECK (held IS NOT TRUE OR channel = 'INTERRUPT'),

  ADD CONSTRAINT alert_delivery_held_has_one_reason
    CHECK (held IS NOT TRUE OR channel_reason = 'HELD_FOR_QUIET_HOURS');

COMMENT ON COLUMN alert_delivery.channel IS
  'The channel this recipient''s copy took (04 Phase 7.5), per recipient because quiet hours are '
  'read in the recipient''s own night (DEC-119). NULL on rows written before migration 0028.';

COMMENT ON COLUMN alert_delivery.held IS
  'Whether this was held rather than sent now. Only an interrupt can be held: nothing quieter has '
  'a time it would otherwise have arrived.';

-- No new grant and no new policy. These are three columns on a table whose policies already say
-- who may read a delivery - the recipient and the profile owner - and none of them is health
-- content: a channel, a reason from a closed set, and a boolean.
