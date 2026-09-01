-- 0014_notification_policy.sql
-- Quiet hours and the digest, on the policy row that already exists (spec 04 Phase 7.5).
--
-- Spec references: 04 Phase 7.5 (urgency-based delivery policy; digest policy for lower urgency;
-- quiet hours; deduplication identifiers; current-state revalidation when opened), 09 (a foreign
-- ingredient restriction defaults to INFORMATIONAL), 02 (alarm-optimised design is an
-- anti-feature), 15 A6 (a notification leaking health information to a lock screen), 16 (the
-- owner decides how much of their health information leaves the app).
--
-- WHY THIS EXTENDS A TABLE RATHER THAN ADDING ONE
-- profile_notification_policy already answers "how much may a caregiver notification reveal for
-- this profile". When and whether it arrives is the same kind of question about the same subject,
-- set by the same person under the same policy, and a second table would need its own RLS, its
-- own grants and its own reason for existing. It has none.
--
-- WHAT IS DELIBERATELY NOT HERE
-- No digest queue table. A digest queue is a list of things waiting to be sent, and BLK-009 means
-- nothing is sent: real push delivery has no credential, no provider and no device. A table whose
-- rows nobody would ever drain is speculative structure that later readers would mistake for a
-- working mechanism. The decision - which channel an urgency may use, and whether quiet hours
-- hold it - is pure and is tested in @kynviora/domain; the queue arrives with the dispatcher.
--
-- No timezone column either, and that is the honest gap rather than an oversight. Quiet hours are
-- stored as minutes from local midnight and the recipient's local minute is supplied by the
-- caller, because Kynviora holds no timezone for anybody and no device has ever reported one
-- (BLK-002). Storing an offset would mean storing a number somebody invented, and it would be
-- wrong twice a year. DEV-030 records where the value has to come from.

ALTER TABLE profile_notification_policy
  -- Minutes from local midnight. NULL together means no quiet hours are set, which is the
  -- default: Kynviora does not decide when a household sleeps.
  ADD COLUMN quiet_hours_start_minute integer,
  ADD COLUMN quiet_hours_end_minute   integer,
  -- The lowest urgency that may reach a device at all, as a further ceiling under the one the
  -- urgency vocabulary already imposes. NULL means the vocabulary's own ceiling stands.
  ADD COLUMN min_urgency_for_device   text;

ALTER TABLE profile_notification_policy
  -- Both or neither. One bound alone is a window whose other end the reader has to invent, and
  -- the thing being invented is whether somebody is woken up.
  ADD CONSTRAINT notification_quiet_hours_paired CHECK (
    (quiet_hours_start_minute IS NULL) = (quiet_hours_end_minute IS NULL)
  ),
  ADD CONSTRAINT notification_quiet_hours_in_range CHECK (
    quiet_hours_start_minute IS NULL OR (
      quiet_hours_start_minute >= 0 AND quiet_hours_start_minute < 1440
      AND quiet_hours_end_minute >= 0 AND quiet_hours_end_minute < 1440
    )
  ),
  -- Equal bounds are a zero-length window or a whole-day one depending on which way it is read,
  -- and a rule whose meaning depends on the reader has no place deciding whether a phone lights
  -- up at three in the morning. The domain guard refuses the same shape.
  ADD CONSTRAINT notification_quiet_hours_distinct CHECK (
    quiet_hours_start_minute IS NULL OR quiet_hours_start_minute <> quiet_hours_end_minute
  ),
  -- Exactly the ACTION_URGENCIES vocabulary. A test reads this constraint out of the catalog and
  -- compares it with the domain's list, so the two cannot drift.
  ADD CONSTRAINT notification_min_urgency_valid CHECK (
    min_urgency_for_device IS NULL OR min_urgency_for_device IN (
      'CRITICAL','HIGH','MEDIUM','LOW','INFORMATIONAL')
  );

COMMENT ON COLUMN profile_notification_policy.quiet_hours_start_minute IS
  'Minutes from LOCAL midnight, not UTC. The recipient local time is supplied by the caller '
  'because Kynviora stores no timezone for anybody (DEV-030). Start may exceed end - 22:00 to '
  '07:00 is the window people mean.';

COMMENT ON COLUMN profile_notification_policy.min_urgency_for_device IS
  'A further ceiling under the urgency vocabulary own one. It can only quieten: an urgency whose '
  'channel is already IN_APP_ONLY cannot be raised by setting this, because spec 04 Phase 7.5 '
  'exit criterion 1 says a foreign restriction does not automatically produce a high-severity '
  'personal alert, and a default somebody can flip is not a default.';

-- ---------------------------------------------------------------------------
-- notification_revalidation
-- ---------------------------------------------------------------------------
-- Exit criterion 2: "Stale/corrected notifications cannot remain actionable without
-- revalidation."
--
-- The enforcement is not this table. It is that the read which renders the alert performs the
-- revalidation, so a client cannot skip it and still act. This records that a revalidation
-- happened and what it found, which is what makes the criterion auditable rather than merely
-- true - spec 20 asks for operational evidence, and "a stale notification was opened and the
-- actions were withdrawn" is exactly the event an incident review would look for.
--
-- No profile column and no item: a row here says an alert was re-read and what the re-read
-- concluded. Spec 20 keeps medicine names and subjects out of operational tables, and the alert
-- reference is enough to join back for anybody entitled to.

CREATE TABLE notification_revalidation (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_publication_id uuid NOT NULL REFERENCES alert_publication (id) ON DELETE CASCADE,
  -- Who opened it. The person who was notified is entitled to know their own notification went
  -- stale, and nobody else reads these rows.
  opened_by_user_id    uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  -- When the notification claimed to have been issued, as reported by the client opening it.
  notified_at          timestamptz NOT NULL,
  revalidated_at       timestamptz NOT NULL,
  outcome              text NOT NULL,

  CONSTRAINT revalidation_outcome_valid CHECK (outcome IN (
    'STILL_CURRENT','WITHDRAWN','SUPERSEDED','CORRECTED_SINCE_NOTIFICATION','NO_LONGER_VISIBLE'))
);

CREATE INDEX revalidation_publication_idx
  ON notification_revalidation (alert_publication_id, revalidated_at DESC);

-- A revalidation happened. It cannot be un-happened, for the same reason alert_delivery cannot:
-- a table that could be edited afterwards is unable to answer the question it exists for.
CREATE TRIGGER notification_revalidation_append_only
  BEFORE UPDATE OR DELETE ON notification_revalidation
  FOR EACH ROW EXECUTE FUNCTION kynviora.forbid_mutation();

COMMENT ON TABLE notification_revalidation IS
  'That an alert opened from a notification was re-read, and what the re-read found. Records no '
  'medicine, no profile and no notification body (spec 20, 15 A6).';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

ALTER TABLE notification_revalidation ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_revalidation FORCE ROW LEVEL SECURITY;

-- The app role reads its own rows and writes none. Writing is privileged for the same reason a
-- safety receipt insert is: a person may report that they opened something, not create rows
-- naming whichever alert and user they like.
GRANT SELECT ON notification_revalidation TO kynviora_app;
GRANT SELECT, INSERT ON notification_revalidation TO kynviora_service;

CREATE POLICY revalidation_read_own ON notification_revalidation
  FOR SELECT TO kynviora_app
  USING (opened_by_user_id = kynviora.current_user_id());

CREATE POLICY revalidation_service ON notification_revalidation
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);
