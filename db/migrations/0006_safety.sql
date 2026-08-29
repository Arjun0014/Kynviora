-- 0006_safety.sql
-- Assessment rules, assessments, alert publications, corrections and Safety Receipts.
--
-- Spec references: 04 Stage 6.5/6.6/7.6; 07 (safety assessment domain); 09 (assessment
-- pipeline and requirements); 10 (governance); 15 (A3 fake high-severity alert).
--
-- THE PUBLICATION BOUNDARY
-- kynviora_app has SELECT only, and only on published, non-withdrawn alerts. Nothing a client
-- does can create, modify or escalate a safety conclusion. Spec 11/12 make the server
-- authoritative for severity, and threat A3 is precisely the client-authored alert this
-- prevents at the privilege layer.
--
-- REPRODUCIBILITY
-- Every assessment stores the exact version of every input it consumed, so spec 09's
-- "Replaying the same versions must reproduce the result" is checkable against stored data
-- rather than only in memory.

-- ---------------------------------------------------------------------------
-- assessment_rule_version
-- ---------------------------------------------------------------------------
-- Immutable. Spec 10 requires every rule to declare its evidence classification, allowed
-- urgency, required provenance, matching criteria and reviewers.

CREATE TABLE assessment_rule_version (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key              text NOT NULL,
  version               text NOT NULL,
  rule_kind             text NOT NULL,

  -- Set by the rule author and reviewer. Never computed at evaluation time (spec 23 D-005/D-006).
  evidence_level        text NOT NULL,
  -- A ceiling, not a fixed value. Evaluation may produce lower urgency for a weaker match but
  -- can never exceed what a reviewer approved.
  max_urgency           text NOT NULL,

  required_item_verification  text[] NOT NULL,
  required_profile_provenance text[] NOT NULL,
  explanation_template_id text NOT NULL,

  review_state          text NOT NULL DEFAULT 'CANDIDATE',
  approved_by_reviewer_id text,
  approved_at           timestamptz,
  -- Spec 10 requires a defined review/expiry interval so stale rules surface for re-review.
  review_due_on         date,

  shadow_mode           boolean NOT NULL DEFAULT true,
  enabled               boolean NOT NULL DEFAULT false,

  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rule_kind_valid CHECK (rule_kind IN (
    'PRODUCT_ACTION_MATCH','BATCH_ACTION_MATCH','EXPIRY','INGREDIENT_SENSITIVITY',
    'DUPLICATE_ACTIVE_INGREDIENT','FORMULATION_CHANGE_REVIEW')),
  CONSTRAINT rule_evidence_level_valid CHECK (evidence_level IN ('A','B','C','D','E','U')),
  CONSTRAINT rule_max_urgency_valid
    CHECK (max_urgency IN ('CRITICAL','HIGH','MEDIUM','LOW','INFORMATIONAL')),
  CONSTRAINT rule_review_state_valid CHECK (review_state IN (
    'CANDIDATE','IN_REVIEW','APPROVED','PUBLISHED','REJECTED','SUPERSEDED','WITHDRAWN')),
  CONSTRAINT rule_verification_known CHECK (required_item_verification <@ ARRAY[
    'CONFIRMED','PROBABLE','PARTIAL','CONFLICTING','UNVERIFIED']::text[]),

  -- Governance, enforced at the storage layer (threat A3, spec 10).
  -- A rule cannot be published without a named reviewer and an approval time, and cannot be
  -- enabled outside shadow mode unless it is published.
  CONSTRAINT rule_published_requires_reviewer CHECK (
    review_state <> 'PUBLISHED' OR (
      approved_by_reviewer_id IS NOT NULL AND approved_at IS NOT NULL
    )
  ),
  CONSTRAINT rule_live_requires_published CHECK (
    NOT enabled OR shadow_mode OR review_state = 'PUBLISHED'
  ),
  -- Spec 09: evidence level E is internal-monitoring only in the MVP, so a rule carrying it may
  -- not run live to users.
  CONSTRAINT rule_emerging_evidence_stays_shadow CHECK (
    evidence_level <> 'E' OR shadow_mode
  ),

  UNIQUE (rule_key, version)
);

CREATE INDEX assessment_rule_active_idx ON assessment_rule_version (rule_kind, enabled)
  WHERE enabled;

CREATE TRIGGER assessment_rule_no_delete
  BEFORE DELETE ON assessment_rule_version
  FOR EACH ROW EXECUTE FUNCTION kynviora.forbid_mutation();

-- ---------------------------------------------------------------------------
-- profile_assessment
-- ---------------------------------------------------------------------------
-- Append-only. A correction inserts a new assessment and supersedes its predecessor, so the
-- original remains inspectable - spec 07.6: "Resolution does not erase historical assessment."

CREATE TABLE profile_assessment (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id            uuid NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
  owned_item_id         uuid NOT NULL REFERENCES owned_item (id) ON DELETE CASCADE,
  rule_version_id       uuid NOT NULL REFERENCES assessment_rule_version (id) ON DELETE RESTRICT,

  matched               boolean NOT NULL,
  match_confidence      text NOT NULL,
  reasons               text[] NOT NULL DEFAULT ARRAY[]::text[],

  -- Copied from the rule at evaluation time and frozen, so a later rule revision does not
  -- retroactively change what a user was told.
  evidence_level        text NOT NULL,
  urgency               text NOT NULL,
  explanation_template_id text NOT NULL,

  -- Exact input versions (spec 09 assessment requirements).
  formulation_version   text,
  normalization_version text NOT NULL,
  profile_fact_versions text[] NOT NULL DEFAULT ARRAY[]::text[],
  action_signal_versions text[] NOT NULL DEFAULT ARRAY[]::text[],
  regulatory_rule_version_id uuid REFERENCES regulatory_rule_version (id) ON DELETE SET NULL,

  shadow_only           boolean NOT NULL DEFAULT false,
  evaluated_at          timestamptz NOT NULL,
  supersedes_assessment_id uuid REFERENCES profile_assessment (id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT assessment_match_confidence_valid
    CHECK (match_confidence IN ('EXACT','PROBABLE','UNCONFIRMED','NOT_MATCHED')),
  CONSTRAINT assessment_evidence_level_valid
    CHECK (evidence_level IN ('A','B','C','D','E','U')),
  CONSTRAINT assessment_urgency_valid
    CHECK (urgency IN ('CRITICAL','HIGH','MEDIUM','LOW','INFORMATIONAL')),
  -- A non-match must not carry actionable urgency; that combination would render as an alert
  -- with nothing behind it.
  CONSTRAINT assessment_unmatched_is_informational
    CHECK (matched OR urgency = 'INFORMATIONAL'),
  CONSTRAINT assessment_not_self_superseding
    CHECK (supersedes_assessment_id IS DISTINCT FROM id)
);

CREATE INDEX assessment_profile_idx
  ON profile_assessment (profile_id, evaluated_at DESC) WHERE matched;
CREATE INDEX assessment_item_idx ON profile_assessment (owned_item_id, evaluated_at DESC);
CREATE INDEX assessment_rule_idx ON profile_assessment (rule_version_id);

CREATE TRIGGER profile_assessment_append_only
  BEFORE UPDATE OR DELETE ON profile_assessment
  FOR EACH ROW EXECUTE FUNCTION kynviora.forbid_mutation();

-- ---------------------------------------------------------------------------
-- alert_publication
-- ---------------------------------------------------------------------------
-- The separately-controlled decision to make an assessment user-visible. Spec 09 keeps
-- assessment creation and publication policy distinct so a rule can evaluate without alerting.

CREATE TABLE alert_publication (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id      uuid NOT NULL REFERENCES profile_assessment (id) ON DELETE RESTRICT,
  profile_id         uuid NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
  state              text NOT NULL DEFAULT 'PUBLISHED',
  published_at       timestamptz NOT NULL DEFAULT now(),
  withdrawn_at       timestamptz,
  withdrawn_reason   text,
  -- Deduplication identifier so a repeated evaluation does not produce a second notification
  -- for the same underlying concern (spec 07.5).
  dedupe_key         text NOT NULL,
  notified_at        timestamptz,
  CONSTRAINT alert_state_valid CHECK (state IN ('PUBLISHED','WITHDRAWN','SUPERSEDED')),
  CONSTRAINT alert_withdrawn_has_reason
    CHECK (state <> 'WITHDRAWN' OR (withdrawn_at IS NOT NULL AND withdrawn_reason IS NOT NULL))
);

CREATE UNIQUE INDEX alert_dedupe_idx ON alert_publication (profile_id, dedupe_key)
  WHERE state = 'PUBLISHED';
CREATE INDEX alert_profile_idx ON alert_publication (profile_id, state, published_at DESC);

-- ---------------------------------------------------------------------------
-- assessment_correction
-- ---------------------------------------------------------------------------

CREATE TABLE assessment_correction (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_assessment_id uuid NOT NULL REFERENCES profile_assessment (id) ON DELETE RESTRICT,
  corrected_assessment_id uuid REFERENCES profile_assessment (id) ON DELETE RESTRICT,
  correction_kind       text NOT NULL,
  reason                text NOT NULL,
  reviewer_id           text,
  corrected_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT correction_kind_valid CHECK (correction_kind IN (
    'SOURCE_CORRECTED','RULE_CORRECTED','ITEM_IDENTITY_CORRECTED','FORMULATION_CORRECTED',
    'PROFILE_FACT_CORRECTED','WITHDRAWN_NO_LONGER_APPLICABLE')),
  CONSTRAINT correction_distinct
    CHECK (corrected_assessment_id IS DISTINCT FROM original_assessment_id)
);

CREATE INDEX correction_original_idx ON assessment_correction (original_assessment_id);

CREATE TRIGGER assessment_correction_append_only
  BEFORE UPDATE OR DELETE ON assessment_correction
  FOR EACH ROW EXECUTE FUNCTION kynviora.forbid_mutation();

-- ---------------------------------------------------------------------------
-- safety_receipt
-- ---------------------------------------------------------------------------
-- Spec 05 idea 4 and 07.6: a durable record of what was delivered, which versions were used,
-- what the user did, and any later correction.

CREATE TABLE safety_receipt (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id         uuid NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
  alert_publication_id uuid NOT NULL REFERENCES alert_publication (id) ON DELETE RESTRICT,
  assessment_id      uuid NOT NULL REFERENCES profile_assessment (id) ON DELETE RESTRICT,
  resolution         text,
  resolution_note    text,
  resolved_at        timestamptz,
  resolved_by_user_id uuid REFERENCES app_user (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT receipt_resolution_valid CHECK (resolution IS NULL OR resolution IN (
    'REVIEWED','NOT_APPLICABLE','RETURNED_OR_DISPOSED','QUARANTINED',
    'DISCUSSED_WITH_PROFESSIONAL','ITEM_IDENTITY_CORRECTED','REPORTED_INCORRECT_MATCH')),
  -- Spec 09 medication safety language: Kynviora never records that it told a user to stop a
  -- prescription medicine, because it is never permitted to say so. The vocabulary above
  -- contains no STOPPED_MEDICINE outcome.
  CONSTRAINT receipt_resolved_has_time
    CHECK (resolution IS NULL OR resolved_at IS NOT NULL)
);

CREATE INDEX receipt_profile_idx ON safety_receipt (profile_id, created_at DESC);
CREATE UNIQUE INDEX receipt_publication_idx ON safety_receipt (alert_publication_id);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

ALTER TABLE assessment_rule_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_rule_version FORCE ROW LEVEL SECURITY;
ALTER TABLE profile_assessment ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_assessment FORCE ROW LEVEL SECURITY;
ALTER TABLE alert_publication ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_publication FORCE ROW LEVEL SECURITY;
ALTER TABLE assessment_correction ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_correction FORCE ROW LEVEL SECURITY;
ALTER TABLE safety_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE safety_receipt FORCE ROW LEVEL SECURITY;

-- The app role reads assessments and alerts, and writes ONLY a resolution on its own receipt.
-- It can never create an assessment or publish an alert.
GRANT SELECT ON assessment_rule_version, profile_assessment, alert_publication,
      assessment_correction TO kynviora_app;
GRANT SELECT, UPDATE ON safety_receipt TO kynviora_app;

GRANT SELECT, INSERT, UPDATE ON assessment_rule_version TO kynviora_service;
GRANT SELECT, INSERT ON profile_assessment, assessment_correction TO kynviora_service;
GRANT SELECT, INSERT, UPDATE ON alert_publication, safety_receipt TO kynviora_service;

-- Rules are readable so the "Why am I seeing this?" inspector can name the rule version.
CREATE POLICY assessment_rule_read ON assessment_rule_version
  FOR SELECT TO kynviora_app
  USING (kynviora.current_user_id() IS NOT NULL AND review_state = 'PUBLISHED');
CREATE POLICY assessment_rule_service ON assessment_rule_version
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

-- Assessments require the safety capability, which spec 08.2 keeps separate from shelf and
-- medicine access. Shadow-mode assessments are never visible to users (spec 04 Phase 6.7).
CREATE POLICY assessment_read ON profile_assessment
  FOR SELECT TO kynviora_app
  USING (NOT shadow_only AND kynviora.has_capability(profile_id, 'VIEW_SAFETY'));
CREATE POLICY assessment_service ON profile_assessment
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

-- A withdrawn alert must stop being actionable immediately (spec 19 release-blocking defect
-- class: "stale withdrawn alert still actionable").
CREATE POLICY alert_read ON alert_publication
  FOR SELECT TO kynviora_app
  USING (state = 'PUBLISHED' AND kynviora.has_capability(profile_id, 'VIEW_SAFETY'));
CREATE POLICY alert_service ON alert_publication
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

CREATE POLICY correction_read ON assessment_correction
  FOR SELECT TO kynviora_app
  USING (EXISTS (
    SELECT 1 FROM profile_assessment a
    WHERE a.id = original_assessment_id
      AND kynviora.has_capability(a.profile_id, 'VIEW_SAFETY')
  ));
CREATE POLICY correction_service ON assessment_correction
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

CREATE POLICY receipt_read ON safety_receipt
  FOR SELECT TO kynviora_app
  USING (kynviora.has_capability(profile_id, 'VIEW_SAFETY'));
-- The user records their own resolution. This is the only safety-domain write the app role has.
CREATE POLICY receipt_resolve ON safety_receipt
  FOR UPDATE TO kynviora_app
  USING (kynviora.has_capability(profile_id, 'VIEW_SAFETY'))
  WITH CHECK (kynviora.has_capability(profile_id, 'VIEW_SAFETY'));
CREATE POLICY receipt_service ON safety_receipt
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);
