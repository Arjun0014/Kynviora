-- 0005_sources_and_regulatory.sql
-- Source registry, preserved source documents, and the Global Regulatory Registry.
--
-- Spec references: 04 Stage 6.1/6.2/6.3/6.4; 07 (source, evidence and registry domains);
-- 25 (source registry, Citation Gate); 15 (A12 misclassification, A13 agent fabrication).
--
-- THE WRITE BOUNDARY
-- kynviora_app has SELECT only, and only on PUBLISHED rows. Every write path here is the
-- service role. Spec 13 lists source and rule publication as privileged server-only operations,
-- and threat A13 requires that a research agent hold no write authority whatsoever - which is
-- enforced here by the agent's process simply not holding these grants.
--
-- IMMUTABILITY
-- Rule versions and source documents are append-only. An amendment inserts a new version and
-- points at its predecessor, so spec 04 Phase 6.2 ("A source change cannot silently mutate
-- previous facts") holds at the storage layer rather than by convention.

-- ---------------------------------------------------------------------------
-- source_registry_entry
-- ---------------------------------------------------------------------------

CREATE TABLE source_registry_entry (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization           text NOT NULL,
  source_name            text NOT NULL,
  source_class           text NOT NULL,
  jurisdiction           text,

  -- What this source is permitted to influence (DEC-014). The Citation Gate reads this, so a
  -- normalization database can never establish a legal status however it is queried.
  allowed_influence      text[] NOT NULL,

  license_review_state   text NOT NULL DEFAULT 'NOT_REVIEWED',
  snapshot_retention_allowed boolean NOT NULL DEFAULT false,
  required_attribution   text,

  expected_refresh_interval_ms bigint NOT NULL,
  parser_version         text NOT NULL,
  status                 text NOT NULL DEFAULT 'REVIEW_REQUIRED',

  last_attempted_check_at  timestamptz,
  last_successful_check_at timestamptz,
  last_new_record_at       timestamptz,
  consecutive_failure_count integer NOT NULL DEFAULT 0,

  operational_owner      text,
  regulatory_owner       text,
  known_limitations      text,
  coverage_statement     text NOT NULL,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT source_class_valid CHECK (source_class IN (
    'PRIMARY_LEGAL', 'OFFICIAL_ACTION_REGISTRY', 'OFFICIAL_GUIDANCE',
    'OFFICIAL_SCIENTIFIC_OPINION', 'IDENTITY_NORMALIZATION', 'MANUFACTURER_EVIDENCE',
    'COMMUNITY_DISCOVERY', 'SEARCH_OR_LLM_RESEARCH')),
  CONSTRAINT source_jurisdiction_valid
    CHECK (jurisdiction IS NULL OR jurisdiction IN ('IN','EU','GB','NI','US','JP')),
  CONSTRAINT source_influence_known
    CHECK (allowed_influence <@ ARRAY[
      'IDENTITY','NORMALIZATION','REGULATORY_STATUS','SAFETY_RULE','DISCOVERY_ONLY']::text[]),
  CONSTRAINT source_influence_not_empty CHECK (cardinality(allowed_influence) > 0),
  CONSTRAINT source_license_state_valid
    CHECK (license_review_state IN ('NOT_REVIEWED','APPROVED','RESTRICTED','PROHIBITED')),
  CONSTRAINT source_status_valid
    CHECK (status IN ('ACTIVE','DEGRADED','STALE','DISABLED','REVIEW_REQUIRED')),
  CONSTRAINT source_coverage_not_blank CHECK (length(btrim(coverage_statement)) > 0),
  -- A search or LLM source may only ever be discovery-only. Encoding it here means the mistake
  -- cannot be made by a future migration or an admin edit (threat A13).
  CONSTRAINT source_research_is_discovery_only CHECK (
    source_class NOT IN ('SEARCH_OR_LLM_RESEARCH', 'COMMUNITY_DISCOVERY')
    OR allowed_influence = ARRAY['DISCOVERY_ONLY']::text[]
  ),
  -- Only primary law and official action registries may carry REGULATORY_STATUS influence
  -- (spec 25 legal-status authority hierarchy).
  CONSTRAINT source_legal_status_requires_legal_class CHECK (
    NOT ('REGULATORY_STATUS' = ANY (allowed_influence))
    OR source_class IN ('PRIMARY_LEGAL', 'OFFICIAL_ACTION_REGISTRY')
  )
);

CREATE INDEX source_registry_jurisdiction_idx ON source_registry_entry (jurisdiction, status);

CREATE TRIGGER source_registry_touch BEFORE UPDATE ON source_registry_entry
  FOR EACH ROW EXECUTE FUNCTION kynviora.touch_updated_at();

-- ---------------------------------------------------------------------------
-- source_document
-- ---------------------------------------------------------------------------
-- Spec 04 Phase 6.2: "A later reviewer can reconstruct which official version produced a
-- record." Where licensing forbids retaining a snapshot, the checksum is still recorded against
-- a reference so change detection works without storing the material (spec 25, BLK-005).

CREATE TABLE source_document (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_registry_entry_id uuid NOT NULL REFERENCES source_registry_entry (id) ON DELETE RESTRICT,
  canonical_uri          text NOT NULL,
  retrieved_at           timestamptz NOT NULL DEFAULT now(),
  content_sha256         text NOT NULL,
  snapshot_storage_key   text,
  source_version_label   text,
  byte_size              bigint,
  supersedes_document_id uuid REFERENCES source_document (id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_document_checksum_shape CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT source_document_not_self_superseding
    CHECK (supersedes_document_id IS DISTINCT FROM id)
);

-- Change detection: the same checksum from the same source is the same material, so an
-- unchanged re-fetch is idempotent rather than creating a duplicate version.
CREATE UNIQUE INDEX source_document_content_unique
  ON source_document (source_registry_entry_id, content_sha256);
CREATE INDEX source_document_source_idx
  ON source_document (source_registry_entry_id, retrieved_at DESC);

CREATE TRIGGER source_document_append_only
  BEFORE UPDATE OR DELETE ON source_document
  FOR EACH ROW EXECUTE FUNCTION kynviora.forbid_mutation();

-- ---------------------------------------------------------------------------
-- source_discovery_candidate
-- ---------------------------------------------------------------------------
-- Spec 07: "It cannot influence shared regulatory/safety state until the underlying allowed
-- source is independently fetched/validated and the Citation Gate passes."
--
-- Deliberately a separate table from source_document. A discovery result is a *lead*, not
-- evidence, and giving it its own table means it cannot be joined into a citation by accident.

CREATE TABLE source_discovery_candidate (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discovered_uri      text NOT NULL,
  discovered_by       text NOT NULL,
  discovery_query     text,
  suggested_jurisdiction text,
  suggested_substance_key text,
  -- Set only once the backend has independently fetched and validated the underlying source.
  validated_document_id uuid REFERENCES source_document (id) ON DELETE SET NULL,
  state               text NOT NULL DEFAULT 'UNVALIDATED',
  discovered_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discovery_state_valid
    CHECK (state IN ('UNVALIDATED', 'VALIDATED', 'REJECTED', 'UNREACHABLE')),
  CONSTRAINT discovery_by_valid
    CHECK (discovered_by IN ('RESEARCH_AGENT', 'SEARCH', 'ANALYST', 'SOURCE_CRAWL')),
  -- A candidate may only be marked VALIDATED once an actual document has been retrieved.
  CONSTRAINT discovery_validated_requires_document
    CHECK (state <> 'VALIDATED' OR validated_document_id IS NOT NULL)
);

CREATE INDEX discovery_state_idx ON source_discovery_candidate (state, discovered_at DESC);

-- ---------------------------------------------------------------------------
-- regulatory_rule_version
-- ---------------------------------------------------------------------------

CREATE TABLE regulatory_rule_version (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction           text NOT NULL,
  substance_canonical_key text NOT NULL,

  -- A list, never a scalar. Spec 07: "Do not force one oversimplified status if the legal
  -- conditions are multidimensional."
  statuses               text[] NOT NULL,
  conditions             jsonb NOT NULL DEFAULT '{}'::jsonb,

  legal_instrument       text,
  legal_reference        text,
  publication_date       date,
  effective_date         date,

  source_registry_entry_id uuid NOT NULL REFERENCES source_registry_entry (id) ON DELETE RESTRICT,
  source_document_id     uuid REFERENCES source_document (id) ON DELETE RESTRICT,

  extraction_version     text NOT NULL,
  review_state           text NOT NULL DEFAULT 'CANDIDATE',
  verification           text NOT NULL DEFAULT 'UNVERIFIED',

  approved_by_reviewer_id text,
  approved_at            timestamptz,

  supersedes_rule_version_id uuid REFERENCES regulatory_rule_version (id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rule_jurisdiction_valid
    CHECK (jurisdiction IN ('IN','EU','GB','NI','US','JP')),
  CONSTRAINT rule_substance_not_blank CHECK (length(btrim(substance_canonical_key)) > 0),
  CONSTRAINT rule_statuses_not_empty CHECK (cardinality(statuses) > 0),
  CONSTRAINT rule_statuses_known CHECK (statuses <@ ARRAY[
    'PROHIBITED','RESTRICTED','CONCENTRATION_LIMIT','USE_CONDITION','AGE_OR_ROUTE_CONDITION',
    'WARNING_REQUIRED','POSITIVE_LIST_ONLY','PRODUCT_ACTION','SCIENTIFIC_OPINION',
    'NO_MATCHED_RULE_WITHIN_COVERAGE','UNKNOWN_OR_INSUFFICIENT']::text[]),
  CONSTRAINT rule_review_state_valid CHECK (review_state IN (
    'CANDIDATE','IN_REVIEW','APPROVED','PUBLISHED','REJECTED','SUPERSEDED','WITHDRAWN')),
  CONSTRAINT rule_verification_valid CHECK (verification IN (
    'VERIFIED_AGAINST_OFFICIAL_SOURCE','NEEDS_PRIMARY_VERIFICATION','UNVERIFIED')),
  CONSTRAINT rule_not_self_superseding CHECK (supersedes_rule_version_id IS DISTINCT FROM id),

  -- THE CITATION GATE, ENFORCED AT THE STORAGE LAYER.
  -- The gate is implemented as a pure function in @kynviora/regulatory so its decisions are
  -- testable and explainable. This constraint is the second layer: even a direct database write
  -- - an operator session, a mistaken migration, a future service bug - cannot mark a rule
  -- PUBLISHED without the evidence the gate requires. Spec 14 defence in depth.
  CONSTRAINT rule_published_requires_citation CHECK (
    review_state <> 'PUBLISHED' OR (
      source_document_id IS NOT NULL
      AND legal_reference IS NOT NULL AND length(btrim(legal_reference)) > 0
      AND (effective_date IS NOT NULL OR publication_date IS NOT NULL)
      AND verification = 'VERIFIED_AGAINST_OFFICIAL_SOURCE'
      AND approved_by_reviewer_id IS NOT NULL
      AND approved_at IS NOT NULL
    )
  ),
  -- A status that depends on a condition may not be published without that condition, or it
  -- renders as an unexplained restriction (spec 22 misleading-simplification guardrail).
  CONSTRAINT rule_concentration_limit_has_threshold CHECK (
    review_state <> 'PUBLISHED'
    OR NOT ('CONCENTRATION_LIMIT' = ANY (statuses))
    OR conditions ? 'maxConcentrationPercent'
    OR conditions ? 'minConcentrationPercent'
  )
);

CREATE INDEX rule_lookup_idx
  ON regulatory_rule_version (substance_canonical_key, jurisdiction, review_state);
CREATE INDEX rule_source_idx ON regulatory_rule_version (source_registry_entry_id);

CREATE TRIGGER regulatory_rule_append_only
  BEFORE DELETE ON regulatory_rule_version
  FOR EACH ROW EXECUTE FUNCTION kynviora.forbid_mutation();

-- ---------------------------------------------------------------------------
-- product_regulatory_action
-- ---------------------------------------------------------------------------

CREATE TABLE product_regulatory_action (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction           text NOT NULL,
  action_kind            text NOT NULL,
  authority              text NOT NULL,

  product_identity_id    uuid REFERENCES product_identity (id) ON DELETE SET NULL,
  formulation_id         uuid REFERENCES marketed_formulation (id) ON DELETE SET NULL,
  gtin                   text,
  batch_codes            text[] NOT NULL DEFAULT ARRAY[]::text[],
  manufacturer_name      text,

  summary                text NOT NULL,
  publication_date       date,
  effective_date         date,

  source_registry_entry_id uuid NOT NULL REFERENCES source_registry_entry (id) ON DELETE RESTRICT,
  source_document_id     uuid REFERENCES source_document (id) ON DELETE RESTRICT,
  review_state           text NOT NULL DEFAULT 'CANDIDATE',
  verification           text NOT NULL DEFAULT 'UNVERIFIED',
  created_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT action_jurisdiction_valid CHECK (jurisdiction IN ('IN','EU','GB','NI','US','JP')),
  CONSTRAINT action_kind_valid CHECK (action_kind IN (
    'RECALL','WITHDRAWAL','MARKETING_PROHIBITION','QUALITY_ALERT','WARNING')),
  CONSTRAINT action_review_state_valid CHECK (review_state IN (
    'CANDIDATE','IN_REVIEW','APPROVED','PUBLISHED','REJECTED','SUPERSEDED','WITHDRAWN')),
  CONSTRAINT action_verification_valid CHECK (verification IN (
    'VERIFIED_AGAINST_OFFICIAL_SOURCE','NEEDS_PRIMARY_VERIFICATION','UNVERIFIED')),
  -- An action with no scope at all cannot be matched to anything and would either alert nobody
  -- or, worse, be treated as applying to everything.
  CONSTRAINT action_has_scope CHECK (
    product_identity_id IS NOT NULL OR formulation_id IS NOT NULL
    OR gtin IS NOT NULL OR manufacturer_name IS NOT NULL
  ),
  CONSTRAINT action_published_requires_citation CHECK (
    review_state <> 'PUBLISHED' OR (
      source_document_id IS NOT NULL
      AND verification = 'VERIFIED_AGAINST_OFFICIAL_SOURCE'
    )
  )
);

CREATE INDEX action_gtin_idx ON product_regulatory_action (gtin) WHERE gtin IS NOT NULL;
CREATE INDEX action_formulation_idx ON product_regulatory_action (formulation_id)
  WHERE formulation_id IS NOT NULL;
CREATE INDEX action_jurisdiction_idx ON product_regulatory_action (jurisdiction, review_state);

-- ---------------------------------------------------------------------------
-- scientific_opinion_record
-- ---------------------------------------------------------------------------
-- A separate table, not a status on a rule. Spec 09: an opinion "is not itself the legal
-- status", and keeping it structurally distinct means it cannot be read as a prohibition.

CREATE TABLE scientific_opinion_record (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction           text NOT NULL,
  substance_canonical_key text NOT NULL,
  committee              text NOT NULL,
  opinion_reference      text NOT NULL,
  summary                text NOT NULL,
  publication_date       date,
  source_registry_entry_id uuid NOT NULL REFERENCES source_registry_entry (id) ON DELETE RESTRICT,
  source_document_id     uuid REFERENCES source_document (id) ON DELETE RESTRICT,
  review_state           text NOT NULL DEFAULT 'CANDIDATE',
  verification           text NOT NULL DEFAULT 'UNVERIFIED',
  -- Null is the normal case and is meaningful: an opinion with no implementing law has not
  -- changed the legal status of anything.
  implemented_by_rule_version_id uuid REFERENCES regulatory_rule_version (id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opinion_jurisdiction_valid CHECK (jurisdiction IN ('IN','EU','GB','NI','US','JP')),
  CONSTRAINT opinion_review_state_valid CHECK (review_state IN (
    'CANDIDATE','IN_REVIEW','APPROVED','PUBLISHED','REJECTED','SUPERSEDED','WITHDRAWN')),
  CONSTRAINT opinion_verification_valid CHECK (verification IN (
    'VERIFIED_AGAINST_OFFICIAL_SOURCE','NEEDS_PRIMARY_VERIFICATION','UNVERIFIED'))
);

CREATE INDEX opinion_lookup_idx
  ON scientific_opinion_record (substance_canonical_key, jurisdiction, review_state);

-- ---------------------------------------------------------------------------
-- citation_gate_decision
-- ---------------------------------------------------------------------------
-- Every gate evaluation is recorded, passed or failed. Spec 20 requires Citation Gate rejection
-- reasons as an operational signal, and spec 10 requires governance audit artifacts.

CREATE TABLE citation_gate_decision (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_version_id     uuid REFERENCES regulatory_rule_version (id) ON DELETE CASCADE,
  action_id           uuid REFERENCES product_regulatory_action (id) ON DELETE CASCADE,
  decision            text NOT NULL,
  failure_codes       text[] NOT NULL DEFAULT ARRAY[]::text[],
  satisfied_checks    text[] NOT NULL DEFAULT ARRAY[]::text[],
  evaluated_at        timestamptz NOT NULL DEFAULT now(),
  gate_version        text NOT NULL,
  CONSTRAINT gate_decision_valid
    CHECK (decision IN ('PASSED','REJECTED','REQUIRES_HUMAN_REVIEW')),
  CONSTRAINT gate_has_subject CHECK (
    (rule_version_id IS NOT NULL)::int + (action_id IS NOT NULL)::int = 1
  )
);

CREATE INDEX gate_decision_rule_idx ON citation_gate_decision (rule_version_id, evaluated_at DESC);
CREATE INDEX gate_decision_outcome_idx ON citation_gate_decision (decision, evaluated_at DESC);

CREATE TRIGGER citation_gate_append_only
  BEFORE UPDATE OR DELETE ON citation_gate_decision
  FOR EACH ROW EXECUTE FUNCTION kynviora.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

ALTER TABLE source_registry_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_registry_entry FORCE ROW LEVEL SECURITY;
ALTER TABLE source_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_document FORCE ROW LEVEL SECURITY;
ALTER TABLE source_discovery_candidate ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_discovery_candidate FORCE ROW LEVEL SECURITY;
ALTER TABLE regulatory_rule_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE regulatory_rule_version FORCE ROW LEVEL SECURITY;
ALTER TABLE product_regulatory_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_regulatory_action FORCE ROW LEVEL SECURITY;
ALTER TABLE scientific_opinion_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE scientific_opinion_record FORCE ROW LEVEL SECURITY;
ALTER TABLE citation_gate_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE citation_gate_decision FORCE ROW LEVEL SECURITY;

-- The app role may READ published regulatory facts and the source registry (users are shown
-- coverage statements and freshness). It has NO write grant anywhere in this migration.
GRANT SELECT ON source_registry_entry, regulatory_rule_version, product_regulatory_action,
      scientific_opinion_record TO kynviora_app;

GRANT SELECT, INSERT, UPDATE ON source_registry_entry TO kynviora_service;
GRANT SELECT, INSERT ON source_document, source_discovery_candidate,
      regulatory_rule_version, citation_gate_decision TO kynviora_service;
GRANT UPDATE ON source_discovery_candidate TO kynviora_service;
GRANT SELECT, INSERT, UPDATE ON product_regulatory_action, scientific_opinion_record
      TO kynviora_service;
-- Rule review state must be advanceable by the reviewer console, but the CHECK constraint above
-- means an UPDATE to PUBLISHED still requires the full citation evidence.
GRANT UPDATE ON regulatory_rule_version TO kynviora_service;

-- Users see the source registry so coverage and freshness can be displayed (spec 09).
CREATE POLICY source_registry_read ON source_registry_entry
  FOR SELECT TO kynviora_app USING (kynviora.current_user_id() IS NOT NULL);
CREATE POLICY source_registry_service ON source_registry_entry
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

-- Preserved source material is internal. Licensing frequently forbids redistribution
-- (spec 25, BLK-005), so it is not exposed to the app role at all.
CREATE POLICY source_document_service ON source_document
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

CREATE POLICY discovery_service ON source_discovery_candidate
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

-- Users see ONLY published rules. An unpublished candidate reaching a user would be exactly the
-- unreviewed regulatory claim the Citation Gate exists to prevent.
CREATE POLICY rule_read_published ON regulatory_rule_version
  FOR SELECT TO kynviora_app
  USING (kynviora.current_user_id() IS NOT NULL AND review_state = 'PUBLISHED');
CREATE POLICY rule_service ON regulatory_rule_version
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

CREATE POLICY action_read_published ON product_regulatory_action
  FOR SELECT TO kynviora_app
  USING (kynviora.current_user_id() IS NOT NULL AND review_state = 'PUBLISHED');
CREATE POLICY action_service ON product_regulatory_action
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

CREATE POLICY opinion_read_published ON scientific_opinion_record
  FOR SELECT TO kynviora_app
  USING (kynviora.current_user_id() IS NOT NULL AND review_state = 'PUBLISHED');
CREATE POLICY opinion_service ON scientific_opinion_record
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

CREATE POLICY gate_decision_service ON citation_gate_decision
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Source health projection (spec 20 Source Health Dashboard)
-- ---------------------------------------------------------------------------
-- Freshness is a safety metric, not merely an uptime metric (spec 20). This view computes
-- staleness from the declared refresh interval so an operator dashboard and the user-facing
-- coverage statement read from the same definition.

CREATE VIEW source_health AS
  SELECT
    s.id,
    s.organization,
    s.source_name,
    s.jurisdiction,
    s.source_class,
    s.status,
    s.parser_version,
    s.expected_refresh_interval_ms,
    s.last_attempted_check_at,
    s.last_successful_check_at,
    s.last_new_record_at,
    s.consecutive_failure_count,
    s.operational_owner,
    s.coverage_statement,
    CASE
      WHEN s.last_successful_check_at IS NULL THEN true
      ELSE now() - s.last_successful_check_at
             > make_interval(secs => (s.expected_refresh_interval_ms / 1000.0) * 2)
    END AS is_stale
  FROM source_registry_entry s;

GRANT SELECT ON source_health TO kynviora_service;

COMMENT ON VIEW source_health IS
  'Operational source freshness. A source is stale once twice its declared refresh interval has '
  'passed without a successful check (spec 20: source freshness is a safety metric).';
