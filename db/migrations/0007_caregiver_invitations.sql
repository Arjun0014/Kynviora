-- 0007_caregiver_invitations.sql
-- Caregiver invitation flow (spec 04 Phase 8.1, 06 Journey 6, 03 group H).
--
-- Spec references: 14 (authorization, column-level controls, step-up), 15 (caregiver
-- relationship boundary, A2), 13 (privileged server-only operations, idempotency), 07
-- (CaregiverGrant), 20 (audit records actors and versions, never health content).
--
-- WHY A SEPARATE TABLE
-- caregiver_grant.grantee_user_id is NOT NULL, so a grant cannot represent "an invitation to a
-- person who has not signed up yet". That window is exactly what an invitation is, so it gets
-- its own record - and it is the only one of the two that carries a secret.
--
-- THE SECRET IS NEVER STORED
-- Only the SHA-256 of the invitation token is persisted (DEC-018). An invitation token is a
-- bearer credential to another person's health data; storing it in recoverable form would mean
-- a database read, a backup, or a support query discloses live access. This is the same posture
-- 14 requires for passwords, applied to the credential that actually exists in this system.

-- ---------------------------------------------------------------------------
-- caregiver_invitation
-- ---------------------------------------------------------------------------

CREATE TABLE caregiver_invitation (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id             uuid NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
  invited_by_user_id     uuid NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  -- Optional binding to a specific recipient. NULL means any account holding the link may
  -- redeem it, which the API only permits for an owner who explicitly chose a shareable link.
  invited_email_normalized text,
  capabilities           text[] NOT NULL,
  -- SHA-256 hex of the token. Never the token itself.
  token_hash             text NOT NULL,
  status                 text NOT NULL DEFAULT 'PENDING',
  -- When the invitation stops being redeemable. NOT NULL: an invitation that never expires is a
  -- permanent credential sitting in an inbox.
  expires_at             timestamptz NOT NULL,
  -- Optional expiry carried onto the resulting grant (04 Phase 8.1 "expiration option").
  grant_expires_at       timestamptz,
  accepted_at            timestamptz,
  accepted_by_user_id    uuid REFERENCES app_user (id) ON DELETE SET NULL,
  accepted_grant_id      uuid REFERENCES caregiver_grant (id) ON DELETE SET NULL,
  declined_at            timestamptz,
  revoked_at             timestamptz,
  revoked_by_user_id     uuid REFERENCES app_user (id) ON DELETE SET NULL,
  -- Client-generated idempotency key (spec 13). A retried create must not mint a second token.
  client_operation_id    uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT caregiver_invitation_status_valid
    CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED')),

  CONSTRAINT caregiver_invitation_capabilities_not_empty
    CHECK (cardinality(capabilities) > 0),

  -- Same closed vocabulary as caregiver_grant. Duplicated rather than factored into a shared
  -- domain because a CHECK cannot reference another table without a subquery, which Postgres
  -- forbids. A test asserts the two lists agree, so drift fails the suite rather than silently
  -- allowing an invitation to carry a capability no grant can hold.
  CONSTRAINT caregiver_invitation_capabilities_known
    CHECK (capabilities <@ ARRAY[
      'VIEW_SAFETY', 'VIEW_SHELF', 'MANAGE_SHELF', 'VIEW_MEDICINES', 'MANAGE_MEDICINES',
      'VIEW_CARE', 'MANAGE_CARE', 'VIEW_DOCUMENTS', 'EXPORT_SUMMARY', 'RECEIVE_MISSED_DOSE',
      'MANAGE_CAREGIVERS'
    ]::text[]),

  -- 64 lowercase hex characters. Catches a plaintext token written to this column by mistake:
  -- a base64url token is 43 characters and contains non-hex letters, so it cannot satisfy this.
  CONSTRAINT caregiver_invitation_token_hash_shape
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),

  CONSTRAINT caregiver_invitation_expiry_after_creation
    CHECK (expires_at > created_at),

  -- An accepted invitation must name who accepted it and when. Without this, an ACCEPTED row
  -- with a NULL acceptor would make the audit history unable to answer "who was granted access".
  CONSTRAINT caregiver_invitation_accepted_complete
    CHECK (
      (status <> 'ACCEPTED')
      OR (accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL)
    ),

  -- The sender can never be the recipient. caregiver_grant already forbids the equivalent, and
  -- allowing it here would let a user manufacture a grant over a profile they do not own.
  CONSTRAINT caregiver_invitation_no_self_accept
    CHECK (accepted_by_user_id IS NULL OR accepted_by_user_id <> invited_by_user_id),

  CONSTRAINT caregiver_invitation_declined_complete
    CHECK ((status <> 'DECLINED') OR declined_at IS NOT NULL),

  CONSTRAINT caregiver_invitation_revoked_complete
    CHECK ((status <> 'REVOKED') OR (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL))
);

-- The token hash is the lookup key for acceptance, and must be unique: two invitations sharing
-- a hash would make acceptance ambiguous.
CREATE UNIQUE INDEX caregiver_invitation_token_hash_idx
  ON caregiver_invitation (token_hash);

CREATE UNIQUE INDEX caregiver_invitation_operation_idx
  ON caregiver_invitation (client_operation_id)
  WHERE client_operation_id IS NOT NULL;

CREATE INDEX caregiver_invitation_profile_idx
  ON caregiver_invitation (profile_id, status);

CREATE TRIGGER caregiver_invitation_touch BEFORE UPDATE ON caregiver_invitation
  FOR EACH ROW EXECUTE FUNCTION kynviora.touch_updated_at();

COMMENT ON COLUMN caregiver_invitation.token_hash IS
  'SHA-256 of the invitation token. The token itself is returned to the inviter once and is '
  'never stored, logged or recoverable (DEC-018).';

-- ---------------------------------------------------------------------------
-- caregiver_grant additions
-- ---------------------------------------------------------------------------

ALTER TABLE caregiver_grant
  ADD COLUMN invitation_id uuid REFERENCES caregiver_invitation (id) ON DELETE SET NULL,
  ADD COLUMN client_operation_id uuid;

-- One active grant per (profile, caregiver). Without this, a race between two acceptances - or
-- two invitations redeemed at once - could produce two active grants with different capability
-- sets, and kynviora.has_capability would union them. The union of two grants is a permission
-- set no one ever approved, so the database refuses to represent it.
CREATE UNIQUE INDEX caregiver_grant_active_unique
  ON caregiver_grant (profile_id, grantee_user_id)
  WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX caregiver_grant_operation_idx
  ON caregiver_grant (client_operation_id)
  WHERE client_operation_id IS NOT NULL;

COMMENT ON INDEX caregiver_grant_active_unique IS
  'At most one ACTIVE grant per (profile, caregiver). Prevents concurrent acceptance from '
  'producing a unioned capability set that no owner approved.';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

ALTER TABLE caregiver_invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE caregiver_invitation FORCE ROW LEVEL SECURITY;

-- COLUMN-LEVEL GRANT, not a table-level one.
--
-- 14: "Column-level or service-layer controls protect immutable ownership/linkage fields."
-- Row-level security cannot hide a column, and the app role legitimately needs to list
-- invitations for a profile it administers. Enumerating the readable columns - and omitting
-- token_hash - is what makes "the app role cannot read the secret" a database fact rather than
-- a promise about how the queries are written.
GRANT SELECT (
  id, profile_id, invited_by_user_id, invited_email_normalized, capabilities, status,
  expires_at, grant_expires_at, accepted_at, accepted_by_user_id, accepted_grant_id,
  declined_at, revoked_at, revoked_by_user_id, created_at, updated_at
) ON caregiver_invitation TO kynviora_app;

-- No INSERT, UPDATE or DELETE for the app role at all. Spec 13 lists caregiver grant creation
-- and revocation finalisation as privileged server-only operations, and an invitation is the
-- act that creates a grant.
GRANT SELECT, INSERT, UPDATE ON caregiver_invitation TO kynviora_service;

-- Visible to the profile owner, to a caregiver who administers the profile, and to the account
-- that accepted it. Deliberately NOT visible to the intended recipient before acceptance: they
-- hold the token, and matching an invitation to an email address they have not yet proven they
-- control would leak that the profile exists.
CREATE POLICY caregiver_invitation_select ON caregiver_invitation
  FOR SELECT TO kynviora_app
  USING (
    kynviora.owns_profile(profile_id)
    OR kynviora.has_capability(profile_id, 'MANAGE_CAREGIVERS')
    OR accepted_by_user_id = kynviora.current_user_id()
  );

CREATE POLICY caregiver_invitation_service_all ON caregiver_invitation
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);
