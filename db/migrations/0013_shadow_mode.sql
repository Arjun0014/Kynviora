-- 0013_shadow_mode.sql
-- Shadow mode and replay (spec 04 Phase 6.7).
--
-- Spec references: 04 Phase 6.7, 09 (replaying the same versions must reproduce the result),
-- 10 (shadow-mode result where required; false-positive investigation; governance artifacts),
-- 20 (audit without content), 22 (measured validation), 23 D-005 (no aggregate scoring).
--
-- EXIT CRITERION 1, AT THE SCHEMA LEVEL
-- "New high-impact rules can be evaluated without user notification."
--
-- A shadow run's results are deliberately NOT profile_assessment rows. alert_publication requires
-- an assessment_id referencing profile_assessment, so there is no column anywhere that could
-- carry a shadow result into a notification - the tables simply do not connect. And
-- shadow_run_sample has no profile column at all: a reviewer investigating a suspected false
-- positive needs the item, the reasons and the rule version (spec 10), and the person is not part
-- of that. What does not exist cannot be sent to.
--
-- EXIT CRITERION 2
-- "Regulatory data corrections can recompute dependent product views and assessments
-- reproducibly." replay_run records what a recomputation found: how many assessments reproduced,
-- how many moved, and which fields moved. A correction is a diff somebody reads, not an apply.

-- ---------------------------------------------------------------------------
-- shadow_run
-- ---------------------------------------------------------------------------

CREATE TABLE shadow_run (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_version_id        uuid NOT NULL REFERENCES assessment_rule_version (id) ON DELETE RESTRICT,

  -- Spec 04 Phase 6.7 names synthetic and historical datasets. The run itself cannot tell them
  -- apart - it is the same computation - so which one it was is recorded rather than inferred.
  dataset_kind           text NOT NULL,
  dataset_label          text NOT NULL,

  dataset_size           integer NOT NULL,
  matched_items          integer NOT NULL,
  -- Distinct identities and formulations, not rows. Ten packs of one product is one product
  -- affected, and a reviewer judging blast radius needs the first number.
  affected_products      integer NOT NULL,
  affected_formulations  integer NOT NULL,
  -- A count. There is deliberately no accompanying list: see the header.
  potential_user_matches integer NOT NULL,

  reason_counts          jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- The instant the run is about, supplied rather than read from a clock, so the run is itself
  -- replayable (spec 09).
  evaluation_instant     timestamptz NOT NULL,
  normalization_version  text NOT NULL,

  run_by_user_id         uuid NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  run_at                 timestamptz NOT NULL,

  CONSTRAINT shadow_dataset_kind_valid CHECK (dataset_kind IN ('SYNTHETIC', 'HISTORICAL')),
  CONSTRAINT shadow_dataset_label_not_blank CHECK (length(btrim(dataset_label)) > 0),
  CONSTRAINT shadow_counts_non_negative CHECK (
    dataset_size >= 0 AND matched_items >= 0 AND affected_products >= 0
    AND affected_formulations >= 0 AND potential_user_matches >= 0
  ),
  -- More matches than rows, or more affected users than matched items, means the run was
  -- assembled wrong - and a reviewer would be reading a blast radius that never happened.
  CONSTRAINT shadow_matches_within_dataset CHECK (matched_items <= dataset_size),
  CONSTRAINT shadow_users_within_matches CHECK (potential_user_matches <= matched_items)
);

CREATE INDEX shadow_run_rule_idx ON shadow_run (rule_version_id, run_at DESC);

CREATE TRIGGER shadow_run_no_delete
  BEFORE DELETE ON shadow_run
  FOR EACH ROW EXECUTE FUNCTION kynviora.forbid_mutation();

COMMENT ON TABLE shadow_run IS
  'A candidate rule evaluated across a dataset without touching anybody. Carries counts and a '
  'bounded sample, never a list of people: spec 04 Phase 6.7 requires high-impact rules to be '
  'evaluable without user notification, and a run with no recipients in it cannot notify.';

-- ---------------------------------------------------------------------------
-- shadow_run_sample
-- ---------------------------------------------------------------------------
-- A bounded sample of matches, for spec 10's false-positive review.
--
-- owned_item_id deliberately has no foreign key: a synthetic dataset's identifiers need not
-- correspond to rows in owned_item, and requiring them to would make a dry run against invented
-- data impossible. The sample is a staff review artefact, not a reference into user data.

CREATE TABLE shadow_run_sample (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shadow_run_id     uuid NOT NULL REFERENCES shadow_run (id) ON DELETE CASCADE,
  owned_item_id     uuid NOT NULL,
  matched           boolean NOT NULL,
  match_confidence  text NOT NULL,
  reasons           text[] NOT NULL,
  evidence_level    text NOT NULL,
  urgency           text NOT NULL,
  sample_order      integer NOT NULL,

  -- MatchConfidence, not ItemVerification. They are different vocabularies that both contain
  -- PROBABLE, which is exactly why the wrong one passed a fixture before it was noticed.
  CONSTRAINT sample_confidence_valid
    CHECK (match_confidence IN ('EXACT', 'PROBABLE', 'UNCONFIRMED', 'NOT_MATCHED')),
  CONSTRAINT sample_evidence_level_valid CHECK (evidence_level IN ('A','B','C','D','E','U')),
  CONSTRAINT sample_urgency_valid
    CHECK (urgency IN ('CRITICAL','HIGH','MEDIUM','LOW','INFORMATIONAL')),
  CONSTRAINT sample_reasons_not_empty CHECK (cardinality(reasons) > 0),
  -- The sample is taken in dataset order so two reviewers see the same rows and can discuss the
  -- same case. The order is stored rather than implied by insertion.
  CONSTRAINT sample_order_unique UNIQUE (shadow_run_id, sample_order)
);

CREATE INDEX shadow_sample_run_idx ON shadow_run_sample (shadow_run_id, sample_order);

-- ---------------------------------------------------------------------------
-- replay_run
-- ---------------------------------------------------------------------------

CREATE TABLE replay_run (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What changed, and therefore what this replay is testing.
  change_kind           text NOT NULL,
  change_note           text NOT NULL,

  assessments_replayed  integer NOT NULL,
  reproduced            integer NOT NULL,
  changed               integer NOT NULL,
  difference_counts     jsonb NOT NULL DEFAULT '{}'::jsonb,

  run_by_user_id        uuid NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  run_at                timestamptz NOT NULL,

  CONSTRAINT replay_change_kind_valid CHECK (change_kind IN (
    'SOURCE_CORRECTION', 'RULE_VERSION', 'NORMALIZATION_VERSION', 'ROUTINE_VERIFICATION')),
  CONSTRAINT replay_change_note_not_blank CHECK (length(btrim(change_note)) > 0),
  CONSTRAINT replay_counts_non_negative CHECK (
    assessments_replayed >= 0 AND reproduced >= 0 AND changed >= 0
  ),
  -- The two halves must account for the whole. A replay whose numbers do not add up is one
  -- somebody would read as "mostly fine".
  CONSTRAINT replay_counts_add_up CHECK (reproduced + changed = assessments_replayed)
);

CREATE INDEX replay_run_at_idx ON replay_run (run_at DESC);

CREATE TRIGGER replay_run_no_delete
  BEFORE DELETE ON replay_run
  FOR EACH ROW EXECUTE FUNCTION kynviora.forbid_mutation();

-- ---------------------------------------------------------------------------
-- The reviewer console now asks for the evidence
-- ---------------------------------------------------------------------------
-- Spec 10 lists "shadow-mode result where required" among what every rule needs, and the
-- high-severity checklist has a reviewer confirm the expected matched-user volume. Until now that
-- confirmation rested on a judgement; a request that needs two people to publish a safety rule now
-- has to name the shadow run those numbers came from, and the run has to be a run of that rule.
--
-- Attaching a run of a *different* rule is the obvious way to satisfy a requirement like this
-- without meeting it, so the trigger checks the pairing rather than the presence.

ALTER TABLE publication_request
  ADD COLUMN shadow_run_id uuid REFERENCES shadow_run (id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION kynviora.require_shadow_evidence() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_rule uuid;
BEGIN
  IF NEW.action <> 'PUBLISH'
     OR NEW.subject_kind <> 'assessment_rule_version'
     OR NEW.required_approvals < 2 THEN
    RETURN NEW;
  END IF;

  IF NEW.shadow_run_id IS NULL THEN
    RAISE EXCEPTION 'publication_request_needs_shadow_evidence'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT rule_version_id INTO v_rule FROM shadow_run WHERE id = NEW.shadow_run_id;
  IF v_rule IS DISTINCT FROM NEW.subject_id THEN
    RAISE EXCEPTION 'publication_request_shadow_run_is_for_another_rule'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER publication_request_shadow_evidence
  BEFORE INSERT OR UPDATE ON publication_request
  FOR EACH ROW EXECUTE FUNCTION kynviora.require_shadow_evidence();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- Staff software, like the reviewer console it feeds. kynviora_app gets no grant, so there is no
-- row a household member could read - and a shadow run holds the one thing that must never leak
-- from a dry run, which is that a rule would have matched somebody's medicine.

ALTER TABLE shadow_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE shadow_run FORCE ROW LEVEL SECURITY;
ALTER TABLE shadow_run_sample ENABLE ROW LEVEL SECURITY;
ALTER TABLE shadow_run_sample FORCE ROW LEVEL SECURITY;
ALTER TABLE replay_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE replay_run FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON shadow_run TO kynviora_service;
GRANT SELECT, INSERT ON shadow_run_sample TO kynviora_service;
GRANT SELECT, INSERT ON replay_run TO kynviora_service;

CREATE POLICY shadow_run_service ON shadow_run
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);
CREATE POLICY shadow_sample_service ON shadow_run_sample
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);
CREATE POLICY replay_run_service ON replay_run
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);
