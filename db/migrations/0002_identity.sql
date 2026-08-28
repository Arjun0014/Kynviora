-- 0002_identity.sql
-- Users, households, profiles, caregiver grants and consent receipts.
--
-- Spec references: 04 Stage 1, 07 (identity/access domain), 13 (authorization), 15 (A1, A2),
-- 16 (consent).
--
-- This migration establishes the person boundary that every later record hangs off. Spec 07 is
-- explicit that "Household membership is not automatic permission to read every profile", so
-- access to a profile is granted only by ownership or by an explicit, unexpired CaregiverGrant.

-- ---------------------------------------------------------------------------
-- app_user
-- ---------------------------------------------------------------------------
-- Authentication itself is delegated to a managed provider (spec 13). This table holds the
-- application-side identity and lifecycle only - never a password hash.

CREATE TABLE app_user (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_auth_id   text UNIQUE NOT NULL,
  email_normalized   text UNIQUE NOT NULL,
  email_verified_at  timestamptz,
  status             text NOT NULL DEFAULT 'ACTIVE',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  CONSTRAINT app_user_status_valid
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'PENDING_DELETION', 'DELETED'))
);

CREATE TRIGGER app_user_touch BEFORE UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION kynviora.touch_updated_at();

-- ---------------------------------------------------------------------------
-- household
-- ---------------------------------------------------------------------------

CREATE TABLE household (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  CONSTRAINT household_name_not_blank CHECK (length(btrim(display_name)) > 0)
);

CREATE INDEX household_owner_idx ON household (owner_user_id) WHERE deleted_at IS NULL;

CREATE TRIGGER household_touch BEFORE UPDATE ON household
  FOR EACH ROW EXECUTE FUNCTION kynviora.touch_updated_at();

-- ---------------------------------------------------------------------------
-- profile
-- ---------------------------------------------------------------------------
-- Spec 04 Phase 1.2 requires a clear distinction between the account holder and a managed
-- profile, and that "Every item created later must require a profile".
--
-- `owner_user_id` is the user who controls this profile. It is separate from
-- `self_user_id`, which is set only when the profile represents that user themselves. An older
-- adult using Kynviora directly has both set to their own account; a relative's managed profile
-- has an owner but no self_user_id until they claim it.

CREATE TABLE profile (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id   uuid NOT NULL REFERENCES household (id) ON DELETE RESTRICT,
  owner_user_id  uuid NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  self_user_id   uuid REFERENCES app_user (id) ON DELETE SET NULL,
  display_name   text NOT NULL,
  -- Spec 16 data minimisation: an age band is sufficient for the MVP rule set, so an exact date
  -- of birth is optional and separately consented.
  birth_year     integer,
  age_band       text,
  language_tag   text NOT NULL DEFAULT 'en-IN',
  is_managed     boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  CONSTRAINT profile_name_not_blank CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT profile_birth_year_plausible
    CHECK (birth_year IS NULL OR (birth_year BETWEEN 1900 AND 2100)),
  CONSTRAINT profile_age_band_valid
    CHECK (age_band IS NULL OR age_band IN
      ('UNDER_3', 'CHILD_3_12', 'TEEN_13_17', 'ADULT_18_64', 'OLDER_ADULT_65_PLUS'))
);

CREATE INDEX profile_household_idx ON profile (household_id) WHERE deleted_at IS NULL;
CREATE INDEX profile_owner_idx ON profile (owner_user_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX profile_self_user_unique ON profile (self_user_id)
  WHERE self_user_id IS NOT NULL AND deleted_at IS NULL;

CREATE TRIGGER profile_touch BEFORE UPDATE ON profile
  FOR EACH ROW EXECUTE FUNCTION kynviora.touch_updated_at();

-- ---------------------------------------------------------------------------
-- caregiver_grant
-- ---------------------------------------------------------------------------
-- Spec 07: an explicit authorization linking a user to profiles and capabilities.
-- Spec 15 A2: a revoked caregiver must not retain access. Revocation is therefore a stored
-- timestamp checked by every policy, not a client-side state.

CREATE TABLE caregiver_grant (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id        uuid NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
  grantee_user_id   uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  granted_by_user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  capabilities      text[] NOT NULL,
  status            text NOT NULL DEFAULT 'PENDING',
  invited_at        timestamptz NOT NULL DEFAULT now(),
  accepted_at       timestamptz,
  expires_at        timestamptz,
  revoked_at        timestamptz,
  revoked_by_user_id uuid REFERENCES app_user (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT caregiver_grant_status_valid
    CHECK (status IN ('PENDING', 'ACTIVE', 'REVOKED', 'EXPIRED', 'DECLINED')),
  CONSTRAINT caregiver_grant_capabilities_not_empty
    CHECK (cardinality(capabilities) > 0),
  -- Every capability must be a member of the vocabulary in packages/domain. Keeping the list in
  -- a CHECK means a typo in application code fails at write time rather than silently creating
  -- an unmatchable capability that appears to grant nothing (or, worse, is later mistyped in a
  -- policy the other way round).
  CONSTRAINT caregiver_grant_capabilities_known
    CHECK (capabilities <@ ARRAY[
      'VIEW_SAFETY', 'VIEW_SHELF', 'MANAGE_SHELF', 'VIEW_MEDICINES', 'MANAGE_MEDICINES',
      'VIEW_CARE', 'MANAGE_CARE', 'VIEW_DOCUMENTS', 'EXPORT_SUMMARY', 'RECEIVE_MISSED_DOSE',
      'MANAGE_CAREGIVERS'
    ]::text[]),
  CONSTRAINT caregiver_grant_no_self_grant
    CHECK (grantee_user_id <> granted_by_user_id)
);

CREATE INDEX caregiver_grant_grantee_idx ON caregiver_grant (grantee_user_id, status);
CREATE INDEX caregiver_grant_profile_idx ON caregiver_grant (profile_id, status);

CREATE TRIGGER caregiver_grant_touch BEFORE UPDATE ON caregiver_grant
  FOR EACH ROW EXECUTE FUNCTION kynviora.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Access helper functions
-- ---------------------------------------------------------------------------
-- These are the single definition of "may this user reach this profile". Policies call them so
-- the rule exists once; spec 19 requires negative authorization tests against exactly these
-- paths.
--
-- SECURITY DEFINER is required: the helper reads `profile` and `caregiver_grant` to answer the
-- question, but the calling role must not gain the ability to read those rows generally.
-- search_path is pinned to defeat search-path hijacking.

CREATE OR REPLACE FUNCTION kynviora.owns_profile(target_profile_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profile p
    WHERE p.id = target_profile_id
      AND p.deleted_at IS NULL
      AND p.owner_user_id = kynviora.current_user_id()
  );
$$;

-- An active grant is one that has been accepted, not revoked, and not past its expiry.
-- Spec 15 A2 ("revoked caregiver keeps cached access") is mitigated here: expiry and revocation
-- are evaluated on every access against now(), so a stale client cache confers nothing.
CREATE OR REPLACE FUNCTION kynviora.has_capability(
  target_profile_id uuid,
  required_capability text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT
    kynviora.owns_profile(target_profile_id)
    OR EXISTS (
      SELECT 1 FROM caregiver_grant g
      WHERE g.profile_id = target_profile_id
        AND g.grantee_user_id = kynviora.current_user_id()
        AND g.status = 'ACTIVE'
        AND g.accepted_at IS NOT NULL
        AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at > now())
        AND required_capability = ANY (g.capabilities)
    );
$$;

COMMENT ON FUNCTION kynviora.has_capability(uuid, text) IS
  'Profile access check. Owner always passes; otherwise requires an accepted, unrevoked, '
  'unexpired caregiver grant carrying the named capability. Evaluated per access so revocation '
  'takes effect immediately (spec 15 A2).';

REVOKE ALL ON FUNCTION kynviora.owns_profile(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION kynviora.has_capability(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kynviora.owns_profile(uuid) TO kynviora_app, kynviora_service;
GRANT EXECUTE ON FUNCTION kynviora.has_capability(uuid, text) TO kynviora_app, kynviora_service;

-- ---------------------------------------------------------------------------
-- consent_receipt
-- ---------------------------------------------------------------------------
-- Spec 16: consent is a product state, not static policy text. Receipts are append-only;
-- withdrawal inserts a new receipt rather than editing the original, so the consent history
-- remains auditable (spec 04 Phase 1.4 "Consent state is auditable").

CREATE TABLE consent_receipt (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  profile_id     uuid REFERENCES profile (id) ON DELETE CASCADE,
  purpose        text NOT NULL,
  granted        boolean NOT NULL,
  policy_version text NOT NULL,
  locale         text NOT NULL DEFAULT 'en-IN',
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  supersedes_id  uuid REFERENCES consent_receipt (id) ON DELETE SET NULL,
  CONSTRAINT consent_purpose_valid CHECK (purpose IN (
    'PROFILE_DATA', 'CAREGIVER_SHARING', 'NOTIFICATIONS', 'DIAGNOSTICS_ANALYTICS',
    'DOCUMENT_IMAGE_PROCESSING', 'CATALOG_CONTRIBUTION', 'CONNECTED_HEALTH_DATA',
    'RESEARCH_PROGRAMME'
  ))
);

CREATE INDEX consent_receipt_user_idx ON consent_receipt (user_id, purpose, recorded_at DESC);

CREATE TRIGGER consent_receipt_append_only
  BEFORE UPDATE OR DELETE ON consent_receipt
  FOR EACH ROW EXECUTE FUNCTION kynviora.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_user FORCE ROW LEVEL SECURITY;
ALTER TABLE household ENABLE ROW LEVEL SECURITY;
ALTER TABLE household FORCE ROW LEVEL SECURITY;
ALTER TABLE profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile FORCE ROW LEVEL SECURITY;
ALTER TABLE caregiver_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE caregiver_grant FORCE ROW LEVEL SECURITY;
ALTER TABLE consent_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_receipt FORCE ROW LEVEL SECURITY;

GRANT SELECT, UPDATE ON app_user TO kynviora_app;
GRANT SELECT, INSERT, UPDATE ON household TO kynviora_app;
GRANT SELECT, INSERT, UPDATE ON profile TO kynviora_app;
GRANT SELECT ON caregiver_grant TO kynviora_app;
GRANT SELECT, INSERT ON consent_receipt TO kynviora_app;

GRANT SELECT, INSERT, UPDATE ON app_user TO kynviora_service;
GRANT SELECT, INSERT, UPDATE ON household TO kynviora_service;
GRANT SELECT, INSERT, UPDATE ON profile TO kynviora_service;
GRANT SELECT, INSERT, UPDATE ON caregiver_grant TO kynviora_service;
GRANT SELECT, INSERT ON consent_receipt TO kynviora_service;

-- app_user: a user sees only their own record.
CREATE POLICY app_user_self_select ON app_user
  FOR SELECT TO kynviora_app
  USING (id = kynviora.current_user_id());

CREATE POLICY app_user_self_update ON app_user
  FOR UPDATE TO kynviora_app
  USING (id = kynviora.current_user_id())
  WITH CHECK (id = kynviora.current_user_id());

CREATE POLICY app_user_service_all ON app_user
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

-- household: visible to its owner, and to any user holding a grant on a profile within it.
-- Spec 07: household membership alone is not permission to read every profile, so this grants
-- visibility of the household container only.
CREATE POLICY household_select ON household
  FOR SELECT TO kynviora_app
  USING (
    owner_user_id = kynviora.current_user_id()
    OR EXISTS (
      SELECT 1 FROM profile p
      WHERE p.household_id = household.id
        AND p.deleted_at IS NULL
        AND kynviora.has_capability(p.id, 'VIEW_SHELF')
    )
  );

CREATE POLICY household_insert ON household
  FOR INSERT TO kynviora_app
  WITH CHECK (owner_user_id = kynviora.current_user_id());

CREATE POLICY household_update ON household
  FOR UPDATE TO kynviora_app
  USING (owner_user_id = kynviora.current_user_id())
  WITH CHECK (owner_user_id = kynviora.current_user_id());

CREATE POLICY household_service_all ON household
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

-- profile: owner, the person themselves, or a caregiver with any viewing capability.
CREATE POLICY profile_select ON profile
  FOR SELECT TO kynviora_app
  USING (
    deleted_at IS NULL
    AND (
      owner_user_id = kynviora.current_user_id()
      OR self_user_id = kynviora.current_user_id()
      OR kynviora.has_capability(id, 'VIEW_SHELF')
      OR kynviora.has_capability(id, 'VIEW_SAFETY')
      OR kynviora.has_capability(id, 'VIEW_MEDICINES')
      OR kynviora.has_capability(id, 'VIEW_CARE')
    )
  );

-- A user may only create a profile inside a household they own, and must set themselves as
-- owner. WITH CHECK prevents creating a profile owned by someone else.
CREATE POLICY profile_insert ON profile
  FOR INSERT TO kynviora_app
  WITH CHECK (
    owner_user_id = kynviora.current_user_id()
    AND EXISTS (
      SELECT 1 FROM household h
      WHERE h.id = household_id
        AND h.owner_user_id = kynviora.current_user_id()
        AND h.deleted_at IS NULL
    )
  );

CREATE POLICY profile_update ON profile
  FOR UPDATE TO kynviora_app
  USING (deleted_at IS NULL AND owner_user_id = kynviora.current_user_id())
  WITH CHECK (owner_user_id = kynviora.current_user_id());

CREATE POLICY profile_service_all ON profile
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

-- caregiver_grant: readable by the profile owner and by the grantee. Deliberately NOT writable
-- by kynviora_app at all - spec 13 lists "caregiver grant creation/revocation finalization" as a
-- privileged server-only operation, and spec 12 forbids optimistically changing caregiver grants
-- on the client. Grant mutation flows through the service role after step-up authentication.
CREATE POLICY caregiver_grant_select ON caregiver_grant
  FOR SELECT TO kynviora_app
  USING (
    grantee_user_id = kynviora.current_user_id()
    OR kynviora.owns_profile(profile_id)
  );

CREATE POLICY caregiver_grant_service_all ON caregiver_grant
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

-- consent_receipt: strictly the user's own.
CREATE POLICY consent_select ON consent_receipt
  FOR SELECT TO kynviora_app
  USING (user_id = kynviora.current_user_id());

CREATE POLICY consent_insert ON consent_receipt
  FOR INSERT TO kynviora_app
  WITH CHECK (user_id = kynviora.current_user_id());

CREATE POLICY consent_service_all ON consent_receipt
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);
