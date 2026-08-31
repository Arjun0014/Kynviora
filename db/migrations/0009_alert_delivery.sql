-- 0009_alert_delivery.sql
-- Caregiver alert delivery: who is told, how much they are told, and what was actually sent.
--
-- Spec references: 04 Phase 8.2, 03 group H (separate permission for safety alerts, shelf,
-- medicines and exports; generic notification content by default), 16 (caregiver notifications
-- reveal minimal information by default), 15 A6 (a notification leaking health information to a
-- lock screen), 09 and 19 (a withdrawn alert must stop being actionable), 13 (notification
-- dispatch is a privileged server-only operation).
--
-- WHAT IS STORED, AND WHAT DELIBERATELY IS NOT
-- alert_delivery records that a notification was sent, to whom, and at which disclosure level.
-- It does not store the notification body. The body is reconstructible from the level and the
-- live records, and storing it would put the exact string 15 A6 is about - the one written to be
-- readable on a lock screen - into a durable table with a different access path from the alert
-- it describes. Same reasoning as DEC-022 for Visit Packs: a record of an event, not a copy of
-- it.

-- ---------------------------------------------------------------------------
-- profile_notification_policy
-- ---------------------------------------------------------------------------
-- The owner's ceiling on how much any caregiver notification for this profile may reveal.
-- One row per profile, created on demand; absence means the default, which is the most private
-- setting rather than the most convenient one.
--
-- Exactly one column of policy, deliberately. Every recipient - the owner included - already has
-- a personal preference in notification_preference, so an owner_detail column here would be a
-- second answer to a question that has one, and the two could disagree.

CREATE TABLE profile_notification_policy (
  profile_id            uuid PRIMARY KEY REFERENCES profile (id) ON DELETE CASCADE,
  -- Ceiling for caregivers. GENERIC by default (03 group H).
  max_caregiver_detail  text NOT NULL DEFAULT 'GENERIC',
  updated_by_user_id    uuid REFERENCES app_user (id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notification_policy_caregiver_detail_valid
    CHECK (max_caregiver_detail IN ('GENERIC', 'CATEGORY', 'NAMED'))
);

CREATE TRIGGER profile_notification_policy_touch BEFORE UPDATE ON profile_notification_policy
  FOR EACH ROW EXECUTE FUNCTION kynviora.touch_updated_at();

COMMENT ON COLUMN profile_notification_policy.max_caregiver_detail IS
  'Owner-set ceiling. The effective level for a caregiver is the narrower of this and their own '
  'preference, so neither dial can widen what the other allows.';

-- ---------------------------------------------------------------------------
-- notification_preference
-- ---------------------------------------------------------------------------
-- A recipient's own setting, for their own device, per profile they receive notifications for.

CREATE TABLE notification_preference (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  profile_id          uuid NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
  detail_level        text NOT NULL DEFAULT 'GENERIC',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notification_preference_detail_valid
    CHECK (detail_level IN ('GENERIC', 'CATEGORY', 'NAMED'))
);

-- One preference per person per profile. Two rows would mean two answers to a question that has
-- one, and whichever the query happened to read would decide what appeared on a lock screen.
CREATE UNIQUE INDEX notification_preference_user_profile_idx
  ON notification_preference (user_id, profile_id);

CREATE TRIGGER notification_preference_touch BEFORE UPDATE ON notification_preference
  FOR EACH ROW EXECUTE FUNCTION kynviora.touch_updated_at();

-- ---------------------------------------------------------------------------
-- alert_delivery
-- ---------------------------------------------------------------------------

CREATE TABLE alert_delivery (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id           uuid NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
  recipient_user_id    uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  event_kind           text NOT NULL,
  -- Present for a SAFETY_ALERT, NULL for a MISSED_DOSE, which has no publication.
  alert_publication_id uuid REFERENCES alert_publication (id) ON DELETE CASCADE,
  -- A missed-dose delivery is about a specific scheduled occurrence, which is what makes the
  -- dedupe key below meaningful for it.
  dose_occurrence_key  text,
  -- The level actually used. Never the body - see the header note.
  detail_level         text NOT NULL,
  delivered_at         timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT alert_delivery_event_kind_valid
    CHECK (event_kind IN ('SAFETY_ALERT', 'MISSED_DOSE')),
  CONSTRAINT alert_delivery_detail_valid
    CHECK (detail_level IN ('GENERIC', 'CATEGORY', 'NAMED')),
  -- Each event kind must carry exactly the reference that identifies it. Without this, a
  -- missed-dose row could borrow a publication ID and appear in the safety history of an alert
  -- it has nothing to do with.
  CONSTRAINT alert_delivery_reference_matches_kind
    CHECK (
      (event_kind = 'SAFETY_ALERT'
        AND alert_publication_id IS NOT NULL AND dose_occurrence_key IS NULL)
      OR
      (event_kind = 'MISSED_DOSE'
        AND alert_publication_id IS NULL AND dose_occurrence_key IS NOT NULL)
    )
);

-- Deduplication. 07.5 already requires that a repeated evaluation not produce a second
-- notification for the same concern; these indexes make that true per recipient rather than only
-- per profile, so a caregiver added after the first dispatch still gets told exactly once.
CREATE UNIQUE INDEX alert_delivery_publication_recipient_idx
  ON alert_delivery (alert_publication_id, recipient_user_id)
  WHERE alert_publication_id IS NOT NULL;

CREATE UNIQUE INDEX alert_delivery_dose_recipient_idx
  ON alert_delivery (profile_id, dose_occurrence_key, recipient_user_id)
  WHERE dose_occurrence_key IS NOT NULL;

CREATE INDEX alert_delivery_recipient_idx
  ON alert_delivery (recipient_user_id, delivered_at DESC);

-- A delivery happened. It cannot be un-happened, and a table that could be edited afterwards
-- would be unable to answer the one question it exists for.
CREATE TRIGGER alert_delivery_append_only
  BEFORE UPDATE OR DELETE ON alert_delivery
  FOR EACH ROW EXECUTE FUNCTION kynviora.forbid_mutation();

COMMENT ON TABLE alert_delivery IS
  'Record that a notification was sent, to whom, and at which disclosure level. Deliberately '
  'stores no notification body (15 A6).';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

ALTER TABLE profile_notification_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_notification_policy FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preference FORCE ROW LEVEL SECURITY;
ALTER TABLE alert_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_delivery FORCE ROW LEVEL SECURITY;

GRANT SELECT ON profile_notification_policy TO kynviora_app;
GRANT SELECT, INSERT, UPDATE ON notification_preference TO kynviora_app;
GRANT SELECT ON alert_delivery TO kynviora_app;
GRANT SELECT, INSERT, UPDATE ON profile_notification_policy TO kynviora_service;
GRANT SELECT, INSERT, UPDATE ON notification_preference TO kynviora_service;
GRANT SELECT, INSERT ON alert_delivery TO kynviora_service;

-- The policy is readable by anyone who receives notifications for the profile, because it is
-- part of the explanation for why their own notification says what it says. 16 requires grant
-- capabilities to be human-readable; a ceiling the recipient cannot see would make their own
-- setting inexplicable to them.
CREATE POLICY notification_policy_read ON profile_notification_policy
  FOR SELECT TO kynviora_app
  USING (
    kynviora.owns_profile(profile_id)
    OR kynviora.has_capability(profile_id, 'VIEW_SAFETY')
    OR kynviora.has_capability(profile_id, 'RECEIVE_MISSED_DOSE')
  );

-- Only the owner sets the ceiling, and only through the service role: 16 gives the owner the say
-- over how much of their health information leaves the app, and MANAGE_CAREGIVERS deliberately
-- does not carry it. A caregiver administrator who could raise the disclosure ceiling could
-- widen what every other caregiver sees without the owner observing it - the same escalation
-- DEC-020 refuses for delegation.
CREATE POLICY notification_policy_service ON profile_notification_policy
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

-- A preference is personal: you read and write your own, for a profile you actually receive
-- notifications for. Not the owner's business which lock screen setting a caregiver chose.
CREATE POLICY notification_preference_own ON notification_preference
  FOR SELECT TO kynviora_app
  USING (user_id = kynviora.current_user_id());

CREATE POLICY notification_preference_insert_own ON notification_preference
  FOR INSERT TO kynviora_app
  WITH CHECK (
    user_id = kynviora.current_user_id()
    AND (
      kynviora.owns_profile(profile_id)
      OR kynviora.has_capability(profile_id, 'VIEW_SAFETY')
      OR kynviora.has_capability(profile_id, 'RECEIVE_MISSED_DOSE')
    )
  );

CREATE POLICY notification_preference_update_own ON notification_preference
  FOR UPDATE TO kynviora_app
  USING (user_id = kynviora.current_user_id())
  WITH CHECK (user_id = kynviora.current_user_id());

CREATE POLICY notification_preference_service ON notification_preference
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

-- A delivery row is visible to the person it was sent to, and to the profile owner, who is
-- entitled to know what left their profile and to whom. A caregiver sees their own deliveries
-- and never another caregiver's: 16 forbids using "family" to justify broad hidden access, and
-- one relative's notification history is not another's business.
CREATE POLICY alert_delivery_read ON alert_delivery
  FOR SELECT TO kynviora_app
  USING (
    recipient_user_id = kynviora.current_user_id()
    OR kynviora.owns_profile(profile_id)
  );

CREATE POLICY alert_delivery_service ON alert_delivery
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);
