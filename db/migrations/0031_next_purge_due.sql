-- 0031_next_purge_due.sql
-- When the next row becomes purgeable, so the sweep can be scheduled at a deadline rather than
-- after one.
--
-- Spec references: `16` (personal data purged **within** 30 days; Visit Pack content within 24
-- hours of expiry; unattached capture artifacts within 7 days), `14` (least privilege),
-- `docs/RETENTION.md` sections 3.1, 3.2 and 8.3, DEC-117, DEC-121, DEC-123, `DEV-063`.
--
-- THE PROBLEM THIS SOLVES, EXACTLY
-- Every eligibility floor in `0022` and `0023` sits **on** its deadline: `purge_floor()` is
-- `now() - 30 days`, Visit Pack content becomes purgeable at `expires_at + 24 hours`. A row is
-- therefore eligible at its deadline and removed by the next sweep after it, so it is gone
-- somewhere in `[deadline, deadline + interval]`. With a one-hour interval that is up to an hour
-- past a thirty-day promise - and up to an hour past a **twenty-four hour** one, which is four
-- per cent of the whole deadline.
--
-- `DEV-063` named two ways to close it and both were wrong:
--
--   1. A margin in the floors - purge at `deadline - interval`. It moves every deadline earlier,
--      which changes what the RLS policies admit. `0023` is careful about that boundary for good
--      reasons and it is not a thing to move to make a schedule tidy.
--   2. A continuous sweep. Does not exist, and would be a much larger change for a worse result:
--      a job that runs constantly to purge nothing.
--
-- The third way is neither. **Ask the data when the next deadline is, and wake up then.** No floor
-- moves, no policy changes, nothing is purged one second earlier than it is due, and the overshoot
-- stops being a configured interval.
--
-- WHY IT RETURNS ONLY A TIMESTAMP
-- Because that is all a schedule needs, and anything more would widen a role whose whole design is
-- that it cannot see what it deletes. A caller learns one instant. Not how many rows, not which
-- table, not whose - "something becomes purgeable at 04:12" says nothing about anybody.
--
-- WHY IT IS `SECURITY DEFINER`
-- The retention role's policies admit only rows that are **already** due, which is exactly right
-- and makes the question unanswerable from inside them: a row that becomes purgeable tomorrow is
-- invisible today, so the role that sweeps cannot see its own queue. Same reasoning as
-- `evidence_is_unattached` and `digest_is_empty` in `0023` and `0029`.
--
-- WHY EVERY SUBQUERY LOOKS AT THE FUTURE ONLY
-- Two reasons and the second is the important one. It keeps each scan on the small end of an
-- index rather than over the table's whole history. And it means an already-eligible row cannot
-- pin the answer in the past and turn the worker into a busy loop - which is what a plain
-- `min(deleted_at) + 30 days` would do the moment one row failed to purge.
--
-- WHAT IT DOES NOT COVER, SAID PLAINLY
-- Eligibility that depends on a **future state change** rather than on a clock. An evidence asset
-- attached today may be detached next month, and is then already older than seven days and due
-- immediately; a digest becomes empty when its last entry is purged. Neither has a deadline
-- anything can compute in advance, so both are covered by the periodic interval - which stays,
-- as a ceiling on how long a worker may sleep rather than as the overshoot. `DEV-065`.

CREATE OR REPLACE FUNCTION kynviora.next_purge_due() RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT min(due) FROM (
    -- Items and profiles: thirty days from the revocation stamp. `purge_floor()` rather than a
    -- repeated literal, so the period cannot drift from the policy that enforces it - the
    -- predicate below is `deleted_at + 30 days > now()` rearranged.
    SELECT min(deleted_at) + interval '30 days' AS due
      FROM owned_item WHERE deleted_at > kynviora.purge_floor()
    UNION ALL
    SELECT min(deleted_at) + interval '30 days'
      FROM profile WHERE deleted_at > kynviora.purge_floor()

    -- Visit Pack content: 24 hours after expiry, and only where it has not already been emptied.
    -- The shortest deadline in the matrix and therefore the one this function is most for.
    UNION ALL
    SELECT min(expires_at) + interval '24 hours'
      FROM visit_pack
     WHERE content_purged_at IS NULL AND expires_at > now() - interval '24 hours'

    UNION ALL
    SELECT min(expires_at) + interval '30 days'
      FROM caregiver_invitation WHERE expires_at > kynviora.purge_floor()

    -- Capture artifacts: seven days from creation, for the ones that are unattached. The
    -- attachment test is applied only to rows still inside the window, which is what keeps this
    -- from calling a row-by-row predicate over the whole table.
    UNION ALL
    SELECT min(created_at) + interval '7 days'
      FROM evidence_asset
     WHERE created_at > now() - interval '7 days' AND kynviora.evidence_is_unattached(id)

    -- The two that outlive a deletion, at 24 months. `retention_floor()`, not `purge_floor()`:
    -- `0023` keeps them separate because a single floor function would have been the shortest
    -- possible way to delete an audit log by accident.
    UNION ALL
    SELECT min(occurred_at) + interval '24 months'
      FROM audit_event WHERE occurred_at > kynviora.retention_floor()
    UNION ALL
    SELECT min(recorded_at) + interval '24 months'
      FROM consent_receipt WHERE recorded_at > kynviora.retention_floor()
  ) AS deadlines;
$$;

COMMENT ON FUNCTION kynviora.next_purge_due() IS
  'The earliest instant at which any row becomes purgeable, or NULL when nothing is pending '
  '(DEC-123). One timestamp and nothing else: a schedule needs no more, and a role that cannot '
  'see what it deletes should not learn how much of it there is. Does not cover eligibility that '
  'depends on a future state change rather than a clock - see DEV-065.';

-- The retention role and nobody else. `kynviora_service` has no business knowing when somebody's
-- deleted medicine stops existing, and PUBLIC least of all: a SECURITY DEFINER function inherits
-- the definer's rights, so leaving one executable by PUBLIC is how it becomes a way around a
-- policy.
REVOKE ALL ON FUNCTION kynviora.next_purge_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kynviora.next_purge_due() TO kynviora_retention;
