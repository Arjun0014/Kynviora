-- 0012_reviewer_console.sql
-- Reviewer queue and publication controls (spec 04 Phase 6.6).
--
-- Spec references: 04 Phase 6.6, 10 (required roles, separation of duties, emergency controls,
-- governance audit artifacts), 13 (reviewer console backend), 14 (reviewer/admin security),
-- 15 (reviewer compromise creates false safety publications).
--
-- THE EXIT CRITERIA, AT THE SCHEMA LEVEL
--
-- "High-impact content cannot be published by an unauthorized single path."
-- Spec 14 says there must be "no direct database editing of publication state as normal
-- workflow", which means the constraint has to live below the API rather than in it. So the
-- approval count, the separation of duties, and the requirement that an approver actually holds
-- an active role are triggers on these tables: a direct UPDATE that flips a request to EXECUTED
-- is refused exactly as an API call would be.
--
-- "Publication is attributable, reversible, and scoped to the intended jurisdiction."
-- Every approval names a user and the role they used, and publication_approval is append-only, so
-- the record of who approved what cannot be edited afterwards. Withdrawal is deliberately a
-- one-person operation - see the note on the execution gate. And the gate counts approvals
-- per jurisdiction, so an approval covering GB is not an approval covering NI.

-- ---------------------------------------------------------------------------
-- reviewer
-- ---------------------------------------------------------------------------
-- Spec 14: "Admin/reviewer roles are not inferred from client claims." The right to approve comes
-- from a row here and nowhere else. Spec 13 forbids shared accounts, so a role is held by a user
-- ID rather than by the free-text reviewer name the 0005 and 0006 tables carried.

CREATE TABLE reviewer (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  role               text NOT NULL,
  status             text NOT NULL DEFAULT 'ACTIVE',
  granted_by_user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  granted_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  revoked_reason     text,

  CONSTRAINT reviewer_role_valid CHECK (role IN (
    'CLINICAL_SAFETY_LEAD', 'MEDICATION_SAFETY_REVIEWER', 'PRODUCT_SAFETY_REVIEWER',
    'REGULATORY_LEGAL_REVIEWER', 'SOURCE_OPERATIONS_OWNER', 'CONTENT_PLAIN_LANGUAGE_OWNER')),
  CONSTRAINT reviewer_status_valid CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
  CONSTRAINT reviewer_revoked_is_dated
    CHECK (status <> 'REVOKED' OR revoked_at IS NOT NULL),
  CONSTRAINT reviewer_active_is_undated
    CHECK (status <> 'ACTIVE' OR revoked_at IS NULL),
  -- Nobody grants themselves a reviewer role. Spec 10's separation of duties starts here: the
  -- ability to create an approver is itself a privileged act, and self-granting would make the
  -- two-person rule a formality one compromised account could satisfy.
  CONSTRAINT reviewer_not_self_granted CHECK (user_id <> granted_by_user_id)
);

-- One active grant per person per role. Two would let one person be counted twice by a query
-- that joined on the grant rather than on the user.
CREATE UNIQUE INDEX reviewer_active_role_idx
  ON reviewer (user_id, role) WHERE status = 'ACTIVE';
CREATE INDEX reviewer_role_idx ON reviewer (role, status);

-- ---------------------------------------------------------------------------
-- publication_control
-- ---------------------------------------------------------------------------
-- Spec 10's emergency controls list "block publication globally" alongside "withdraw one alert
-- publication". A single row, so the block is one fact rather than a setting that can be true in
-- one place and false in another.

CREATE TABLE publication_control (
  singleton           boolean PRIMARY KEY DEFAULT true,
  publication_blocked boolean NOT NULL DEFAULT false,
  blocked_reason      text,
  blocked_by_user_id  uuid REFERENCES app_user (id) ON DELETE RESTRICT,
  blocked_at          timestamptz,

  CONSTRAINT publication_control_is_singleton CHECK (singleton),
  -- A block with no reason and no author is indistinguishable from a bug, and it is the first
  -- thing an incident review asks about.
  CONSTRAINT publication_control_block_is_explained CHECK (
    NOT publication_blocked
    OR (blocked_reason IS NOT NULL AND length(btrim(blocked_reason)) > 0
        AND blocked_by_user_id IS NOT NULL AND blocked_at IS NOT NULL)
  )
);

INSERT INTO publication_control (singleton) VALUES (true);

-- ---------------------------------------------------------------------------
-- publication_request
-- ---------------------------------------------------------------------------

CREATE TABLE publication_request (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind          text NOT NULL,
  subject_id            uuid NOT NULL,
  action                text NOT NULL,

  -- The scope the publication is intended to cover. Spec 10 requires Great Britain and Northern
  -- Ireland to be reviewed separately where applicable, so this is a list of jurisdictions each
  -- of which must be approved on its own - not a region.
  jurisdictions         text[] NOT NULL,

  -- Declared by the author, reviewed by the approvers, never computed here.
  max_urgency           text,
  evidence_level        text,
  -- Derived from the two above by the domain policy and stored, so a later change to the policy
  -- cannot retroactively make an already-executed publication look under-reviewed.
  required_approvals    integer NOT NULL,

  state                 text NOT NULL DEFAULT 'OPEN',
  requested_by_user_id  uuid NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  requested_at          timestamptz NOT NULL,
  requested_note        text,
  -- Spec 10 governance artifacts: the correction/withdrawal reason is retained.
  withdrawal_reason     text,

  decided_at            timestamptz,
  decided_by_user_id    uuid REFERENCES app_user (id) ON DELETE RESTRICT,
  client_operation_id   uuid,

  CONSTRAINT request_subject_kind_valid CHECK (subject_kind IN (
    'assessment_rule_version', 'regulatory_rule_version', 'product_regulatory_action',
    'alert_publication')),
  CONSTRAINT request_action_valid CHECK (action IN ('PUBLISH', 'WITHDRAW')),
  CONSTRAINT request_state_valid CHECK (state IN (
    'OPEN', 'EXECUTED', 'REJECTED', 'RETURNED_FOR_CORRECTION', 'CANCELLED')),
  CONSTRAINT request_jurisdictions_not_empty CHECK (cardinality(jurisdictions) > 0),
  CONSTRAINT request_jurisdictions_known
    CHECK (jurisdictions <@ ARRAY['IN','EU','GB','NI','US','JP']::text[]),
  CONSTRAINT request_max_urgency_valid CHECK (
    max_urgency IS NULL OR max_urgency IN ('CRITICAL','HIGH','MEDIUM','LOW','INFORMATIONAL')),
  CONSTRAINT request_evidence_level_valid CHECK (
    evidence_level IS NULL OR evidence_level IN ('A','B','C','D','E','U')),
  CONSTRAINT request_required_approvals_range CHECK (required_approvals BETWEEN 1 AND 2),

  -- A publication declares what it is: spec 10 defines which urgency and evidence classes need
  -- two people, and a request that declared neither could not be classified at all.
  CONSTRAINT request_publish_declares_impact CHECK (
    action <> 'PUBLISH' OR (max_urgency IS NOT NULL AND evidence_level IS NOT NULL)
  ),
  CONSTRAINT request_withdrawal_states_reason CHECK (
    action <> 'WITHDRAW'
    OR (withdrawal_reason IS NOT NULL AND length(btrim(withdrawal_reason)) > 0)
  ),
  CONSTRAINT request_decided_is_attributed CHECK (
    state = 'OPEN' OR (decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL)
  ),
  CONSTRAINT request_open_is_undecided CHECK (
    state <> 'OPEN' OR (decided_at IS NULL AND decided_by_user_id IS NULL)
  )
);

-- One open request per target and action. Without this, two requests for the same publication
-- could each collect one approval and the second could be executed on a count that was never
-- reached for either - the two-person rule defeated by arithmetic rather than by attack.
CREATE UNIQUE INDEX publication_request_open_idx
  ON publication_request (subject_kind, subject_id, action) WHERE state = 'OPEN';
CREATE UNIQUE INDEX publication_request_operation_idx
  ON publication_request (client_operation_id) WHERE client_operation_id IS NOT NULL;
CREATE INDEX publication_request_queue_idx ON publication_request (state, requested_at);

CREATE TRIGGER publication_request_no_delete
  BEFORE DELETE ON publication_request
  FOR EACH ROW EXECUTE FUNCTION kynviora.forbid_mutation();

-- ---------------------------------------------------------------------------
-- publication_approval
-- ---------------------------------------------------------------------------
-- Append-only. Spec 13 and 14 both require immutable audit logs around publication, and an
-- editable approval is not a record of a decision - it is a record of the current story.

CREATE TABLE publication_approval (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id        uuid NOT NULL REFERENCES publication_request (id) ON DELETE RESTRICT,
  reviewer_user_id  uuid NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  -- The role the reviewer used, recorded rather than looked up later: a person may hold two
  -- roles, and which one they were acting in is part of what makes the decision attributable.
  reviewer_role     text NOT NULL,
  decision          text NOT NULL,
  -- What this reviewer actually reviewed. May be narrower than the request.
  jurisdictions     text[] NOT NULL,
  note              text,
  -- Spec 10's high-severity publication checklist, recorded per approval rather than per request:
  -- the point of a second reviewer is that they check independently, and letting the first one's
  -- confirmations stand for both would make the second signature ceremonial.
  checklist_confirmed text[] NOT NULL DEFAULT ARRAY[]::text[],
  decided_at        timestamptz NOT NULL,

  CONSTRAINT approval_role_valid CHECK (reviewer_role IN (
    'CLINICAL_SAFETY_LEAD', 'MEDICATION_SAFETY_REVIEWER', 'PRODUCT_SAFETY_REVIEWER',
    'REGULATORY_LEGAL_REVIEWER', 'SOURCE_OPERATIONS_OWNER', 'CONTENT_PLAIN_LANGUAGE_OWNER')),
  CONSTRAINT approval_decision_valid
    CHECK (decision IN ('APPROVE', 'REJECT', 'RETURN_FOR_CORRECTION')),
  CONSTRAINT approval_jurisdictions_not_empty CHECK (cardinality(jurisdictions) > 0),
  CONSTRAINT approval_jurisdictions_known
    CHECK (jurisdictions <@ ARRAY['IN','EU','GB','NI','US','JP']::text[]),
  CONSTRAINT approval_checklist_known CHECK (checklist_confirmed <@ ARRAY[
    'SOURCE_AUTHENTICITY', 'EXACT_JURISDICTION', 'AFFECTED_IDENTIFIERS',
    'RULE_MATCHING_BEHAVIOUR', 'USER_ACTION_WORDING', 'MEDICATION_BOUNDARY',
    'EXPECTED_MATCH_VOLUME', 'NOTIFICATION_POLICY', 'WITHDRAWAL_READINESS',
    'INCIDENT_OWNER']::text[]),

  -- One person, one decision per request. Counting rows rather than people is the obvious way to
  -- satisfy a two-person rule with one person, so the database refuses the second row outright.
  CONSTRAINT approval_one_per_reviewer UNIQUE (request_id, reviewer_user_id)
);

CREATE INDEX publication_approval_request_idx ON publication_approval (request_id, decided_at);

CREATE TRIGGER publication_approval_append_only
  BEFORE UPDATE OR DELETE ON publication_approval
  FOR EACH ROW EXECUTE FUNCTION kynviora.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Which roles may approve which kind
-- ---------------------------------------------------------------------------
-- Spec 10: regulatory comparison is a separate publication responsibility from clinical safety
-- assessment. The mapping is repeated here rather than trusted to the API, for the same reason
-- the Citation Gate is repeated as a CHECK - a direct write must meet the same bar.

CREATE OR REPLACE FUNCTION kynviora.role_may_approve(p_kind text, p_role text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE p_kind
    WHEN 'assessment_rule_version' THEN p_role IN (
      'CLINICAL_SAFETY_LEAD', 'MEDICATION_SAFETY_REVIEWER', 'PRODUCT_SAFETY_REVIEWER')
    WHEN 'regulatory_rule_version' THEN p_role = 'REGULATORY_LEGAL_REVIEWER'
    WHEN 'product_regulatory_action' THEN p_role IN (
      'REGULATORY_LEGAL_REVIEWER', 'SOURCE_OPERATIONS_OWNER')
    WHEN 'alert_publication' THEN p_role IN (
      'CLINICAL_SAFETY_LEAD', 'MEDICATION_SAFETY_REVIEWER', 'PRODUCT_SAFETY_REVIEWER',
      'CONTENT_PLAIN_LANGUAGE_OWNER')
    ELSE false
  END
$$;

-- ---------------------------------------------------------------------------
-- Approval admission
-- ---------------------------------------------------------------------------
-- Three refusals, each one a named requirement:
--   - the reviewer holds an ACTIVE stored role (spec 14, not inferred from a claim);
--   - the role may approve this kind of content (spec 10, clinical is not regulatory);
--   - the reviewer is not the person who requested the publication (spec 10, separation of
--     duties). Withdrawal is exempt: see the execution gate.

CREATE OR REPLACE FUNCTION kynviora.admit_publication_approval() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_request publication_request%ROWTYPE;
BEGIN
  SELECT * INTO v_request FROM publication_request WHERE id = NEW.request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'publication_approval_request_missing'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_request.state <> 'OPEN' THEN
    RAISE EXCEPTION 'publication_approval_request_not_open'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM reviewer
     WHERE user_id = NEW.reviewer_user_id
       AND role = NEW.reviewer_role
       AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'publication_approval_role_not_held'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NOT kynviora.role_may_approve(v_request.subject_kind, NEW.reviewer_role) THEN
    RAISE EXCEPTION 'publication_approval_role_not_permitted_for_kind'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_request.action = 'PUBLISH'
     AND NEW.reviewer_user_id = v_request.requested_by_user_id THEN
    RAISE EXCEPTION 'publication_approval_separation_of_duties'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NOT (NEW.jurisdictions <@ v_request.jurisdictions) THEN
    RAISE EXCEPTION 'publication_approval_scope_exceeds_request'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Spec 10: before high-severity publication the reviewer must verify ten named things. Content
  -- that needs a second pair of hands is content that needs the checks, so the threshold is the
  -- same one - and an approval that skipped them is refused here as well as in the domain.
  IF v_request.action = 'PUBLISH'
     AND v_request.required_approvals = 2
     AND NEW.decision = 'APPROVE'
     AND NOT (ARRAY[
       'SOURCE_AUTHENTICITY', 'EXACT_JURISDICTION', 'AFFECTED_IDENTIFIERS',
       'RULE_MATCHING_BEHAVIOUR', 'USER_ACTION_WORDING', 'MEDICATION_BOUNDARY',
       'EXPECTED_MATCH_VOLUME', 'NOTIFICATION_POLICY', 'WITHDRAWAL_READINESS',
       'INCIDENT_OWNER']::text[] <@ NEW.checklist_confirmed) THEN
    RAISE EXCEPTION 'publication_approval_checklist_incomplete'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER publication_approval_admission
  BEFORE INSERT ON publication_approval
  FOR EACH ROW EXECUTE FUNCTION kynviora.admit_publication_approval();

-- ---------------------------------------------------------------------------
-- Execution gate
-- ---------------------------------------------------------------------------
-- This is exit criterion 1 in the storage layer. Spec 14 requires that direct editing of
-- publication state is not a normal workflow; making the gate a trigger means it is not an
-- abnormal one either.
--
-- WHY WITHDRAWAL IS EASIER THAN PUBLICATION
-- The two failure modes are not symmetric. A wrongly-published alert tells a real person to do
-- something on Kynviora's authority; a wrongly-withdrawn one removes information, which is the
-- state the product is in for every item it does not cover. Spec 15's reviewer-compromise threat
-- is about creating false publications. So a withdrawal needs one approver, may be executed by
-- the person who asked for it, and is not stopped by a global publication block - blocking
-- publication must never block stopping something.

CREATE OR REPLACE FUNCTION kynviora.gate_publication_execution() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_blocked   boolean;
  v_objection text;
  v_short     text;
BEGIN
  -- A decided request is final. Without this, a second UPDATE to EXECUTED would silently
  -- overwrite decided_by_user_id, and "publication is attributable" would hold only until
  -- somebody wrote to the row again.
  IF OLD.state <> 'OPEN' THEN
    RAISE EXCEPTION 'publication_execution_request_not_open'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Rejection, return-for-correction and cancellation close a request without publishing
  -- anything, so they need no approval count.
  IF NEW.state <> 'EXECUTED' THEN
    RETURN NEW;
  END IF;

  -- A rejection or a return-for-correction is not outvoted by later approvals. Somebody said the
  -- content was not ready; clearing that takes a new request, not more signatures.
  SELECT decision INTO v_objection FROM publication_approval
   WHERE request_id = NEW.id AND decision <> 'APPROVE' LIMIT 1;
  IF v_objection IS NOT NULL THEN
    RAISE EXCEPTION 'publication_execution_outstanding_objection'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.action = 'PUBLISH' THEN
    SELECT publication_blocked INTO v_blocked FROM publication_control WHERE singleton;
    IF v_blocked THEN
      RAISE EXCEPTION 'publication_execution_globally_blocked'
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.decided_by_user_id = NEW.requested_by_user_id THEN
      RAISE EXCEPTION 'publication_execution_separation_of_duties'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM reviewer
     WHERE user_id = NEW.decided_by_user_id AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'publication_execution_executor_not_a_reviewer'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Every requested jurisdiction independently reaches the count. Approving for GB is not
  -- approving for NI (spec 10), and counting DISTINCT reviewers rather than rows is what stops
  -- one person satisfying a two-person rule.
  SELECT string_agg(j, ',') INTO v_short
    FROM unnest(NEW.jurisdictions) AS j
   WHERE (
     SELECT count(DISTINCT a.reviewer_user_id) FROM publication_approval a
      WHERE a.request_id = NEW.id AND a.decision = 'APPROVE' AND j = ANY (a.jurisdictions)
   ) < NEW.required_approvals;

  IF v_short IS NOT NULL THEN
    RAISE EXCEPTION 'publication_execution_insufficient_approvals (%)', v_short
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER publication_request_execution_gate
  BEFORE UPDATE ON publication_request
  FOR EACH ROW EXECUTE FUNCTION kynviora.gate_publication_execution();

-- ---------------------------------------------------------------------------
-- Publication scope on the target record
-- ---------------------------------------------------------------------------
-- Exit criterion 2's "scoped to the intended jurisdiction", made structural rather than recorded
-- only in the request. A safety rule has no jurisdiction column - it would otherwise run
-- everywhere - so publication writes the approved scope onto the rule, and a published rule with
-- no approved scope is unrepresentable.

ALTER TABLE assessment_rule_version
  ADD COLUMN approved_jurisdictions text[] NOT NULL DEFAULT ARRAY[]::text[];

ALTER TABLE assessment_rule_version
  ADD CONSTRAINT rule_approved_jurisdictions_known
    CHECK (approved_jurisdictions <@ ARRAY['IN','EU','GB','NI','US','JP']::text[]);

ALTER TABLE assessment_rule_version
  ADD CONSTRAINT rule_published_has_approved_scope
    CHECK (review_state <> 'PUBLISHED' OR cardinality(approved_jurisdictions) > 0);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- The reviewer console is staff software, not a user surface. kynviora_app gets no grant at all,
-- so there is no row a household member could read even if a route asked for one - the same
-- treatment audit_event gets in 0001, and for the same reason.

ALTER TABLE reviewer ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviewer FORCE ROW LEVEL SECURITY;
ALTER TABLE publication_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE publication_request FORCE ROW LEVEL SECURITY;
ALTER TABLE publication_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE publication_approval FORCE ROW LEVEL SECURITY;
ALTER TABLE publication_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE publication_control FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON reviewer TO kynviora_service;
GRANT SELECT, INSERT, UPDATE ON publication_request TO kynviora_service;
GRANT SELECT, INSERT ON publication_approval TO kynviora_service;
GRANT SELECT, UPDATE ON publication_control TO kynviora_service;

CREATE POLICY reviewer_service ON reviewer
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);
CREATE POLICY publication_request_service ON publication_request
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);
CREATE POLICY publication_approval_service ON publication_approval
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);
CREATE POLICY publication_control_service ON publication_control
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

COMMENT ON TABLE publication_approval IS
  'One decision by one reviewer on one publication request. Append-only, and the UNIQUE '
  '(request_id, reviewer_user_id) is what makes two-person approval mean two people.';

COMMENT ON COLUMN publication_request.jurisdictions IS
  'The intended publication scope. Each entry must reach the approval count on its own - spec 10 '
  'requires Great Britain and Northern Ireland to be reviewed separately where applicable.';
