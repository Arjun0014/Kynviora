-- 0024_recipient_time_zone.sql
-- Where a recipient is, so quiet hours can be theirs (DEC-119, `DEV-030`).
--
-- Spec references: `04` Phase 7.5 (quiet hours), `04` Phase 4.1 (time-zone handling: a local wall
-- clock plus a zone, never a stored offset), `16` (data minimisation), `14`.
--
-- WHAT WAS MISSING
-- `0014` stored the window and said plainly what it could not do: "No timezone column either, and
-- that is the honest gap rather than an oversight." `deliveryDecision` has always taken the
-- recipient's local minute as an input, every caller has always passed `null`, and quiet hours
-- have therefore held nothing since they were built. The gap was never the logic; it was that
-- nobody knew what time it was where the person was.
--
-- WHY ON `app_user` RATHER THAN ON A PREFERENCE
-- Because a person is in one place at a time. `notification_preference` is keyed
-- `(user_id, profile_id)`, so a zone there would let the same person be in two places depending on
-- whose medicines were being discussed - which is not a state anybody can be in, and would be a
-- column two rows could disagree about.
--
-- It is also the recipient's zone rather than the profile's, which is the whole point of `DEV-030`
-- closing this way. A caregiver in London looking after somebody in Kolkata should not be woken at
-- four in the morning because the household's night is elsewhere.
--
-- WHY IANA AND NOT AN OFFSET
-- An offset is a fact about a place *and a date*. `Asia/Kolkata` is a fact about a place.
-- `04` Phase 4.1 already made this decision for schedules and this is the same decision at the
-- other end of the system - and the domain refuses an offset explicitly, because ICU would accept
-- one.
--
-- WHAT IT IS NOT
-- Location. A zone is coarse - hundreds of millions of people share one - and it is collected for
-- one stated purpose, which is deciding whether a notification waits until morning. `16`'s
-- minimisation rule is satisfied by it being a zone rather than a place, and by there being no
-- second use.

ALTER TABLE app_user
  -- NULL means unknown, which is the default and the state every existing row is in. The domain
  -- reads unknown as "do not hold", so a person whose zone Kynviora does not know gets their
  -- notification rather than an indefinite silence - the biased direction, chosen because the
  -- failure it avoids is a CRITICAL recall waiting for a window that never ends.
  ADD COLUMN time_zone text;

ALTER TABLE app_user
  -- Shape only. Whether a runtime knows the zone is a question for the runtime, and a CHECK
  -- constraint cannot ask ICU - so this refuses the shapes that are definitely wrong and the
  -- domain refuses the rest. An offset is definitely wrong: it is the thing this column exists
  -- instead of.
  ADD CONSTRAINT app_user_time_zone_shape CHECK (
    time_zone IS NULL OR (
      length(time_zone) BETWEEN 3 AND 64
      AND time_zone ~ '^[A-Za-z][A-Za-z0-9_+/-]*$'
      AND time_zone !~ '^[+-]'
    )
  );

COMMENT ON COLUMN app_user.time_zone IS
  'IANA zone the person is in, reported by their device, or NULL for unknown (DEC-119). Read only '
  'to decide whether a notification waits for morning. Unknown means do not hold, because an '
  'alert waiting for a window that never ends is the worse failure.';

-- ---------------------------------------------------------------------------
-- Who may write it
-- ---------------------------------------------------------------------------
-- `0002` already grants the app role `UPDATE` on `app_user` under `app_user_self_update`, whose
-- USING clause is `id = kynviora.current_user_id()`. So a person may set their own zone and
-- nobody else's, which is exactly the rule, and no new policy is needed.
--
-- The dispatcher reads it through the service role, which holds `ALL` on this table already. A
-- caregiver cannot read another person's zone: `app_user_self_select` is self-only and stays that
-- way. That matters more than it might seem - a zone is coarse, and it is still a fact about
-- somebody's whereabouts that nobody else in a household has a reason to know.
