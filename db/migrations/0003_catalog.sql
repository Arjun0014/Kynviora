-- 0003_catalog.sql
-- The Living Catalog: shared product knowledge, separate from personal health context.
--
-- Spec references: 04 Stage 3 and 5, 07 (Living Catalog domain), 08 (product identity),
-- 15 (A11 catalog poisoning), 16 (Living Catalog contribution privacy).
--
-- LAYER SEPARATION (spec 08)
-- Eight layers stay distinct, because "a match at one layer never proves all lower layers":
--   product_identity      commercial brand/product concept
--   marketed_formulation  market-specific strength/form or ingredient declaration
--   batch_or_lot          manufacturing scope
--   product_observation   what a real package showed, at a time, in a market
--   evidence_asset        the captured image or document
--   field_assertion       one provenance-bearing claim about one field
--   owned_item            (0004) the item a specific profile uses
--   regulatory knowledge  (0005) maintained entirely separately
--
-- PRIVACY BOUNDARY (spec 16)
-- The shared catalog stores product knowledge, never "this named person uses this product".
-- Contributor linkage lives in `product_observation.contributed_by_user_id`, which is readable
-- only by the service role and the contributor themselves - never by other users reading catalog
-- data.
--
-- WRITE BOUNDARY (spec 03 group K, threat A11)
-- kynviora_app receives SELECT only on every shared catalog table. All catalog writes flow
-- through the service role after server-side validation, so "One user's submission cannot
-- silently rewrite shared catalog truth" is enforced by privilege, not by application care.

-- ---------------------------------------------------------------------------
-- normalized_substance
-- ---------------------------------------------------------------------------
-- Seeded independently of user contributions (spec 08 "What must be seeded before safety use").
-- Crowd observations never create or modify a canonical substance.

CREATE TABLE normalized_substance (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_key     text UNIQUE NOT NULL,
  preferred_name    text NOT NULL,
  inci_name         text,
  cas_number        text,
  ec_number         text,
  pubchem_cid       text,
  substance_kind    text NOT NULL,
  -- Version of the normalization vocabulary this concept belongs to, so a mapping can be
  -- replayed against the vocabulary that produced it (spec 09 assessment requirements).
  vocabulary_version text NOT NULL,
  review_state      text NOT NULL DEFAULT 'CANDIDATE',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT substance_kind_valid
    CHECK (substance_kind IN ('COSMETIC_INGREDIENT', 'ACTIVE_PHARMACEUTICAL', 'EXCIPIENT', 'OTHER')),
  CONSTRAINT substance_review_state_valid
    CHECK (review_state IN ('CANDIDATE', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'REJECTED',
                            'SUPERSEDED', 'WITHDRAWN'))
);

CREATE INDEX normalized_substance_inci_idx ON normalized_substance (lower(inci_name));
CREATE INDEX normalized_substance_cas_idx ON normalized_substance (cas_number);

CREATE TRIGGER normalized_substance_touch BEFORE UPDATE ON normalized_substance
  FOR EACH ROW EXECUTE FUNCTION kynviora.touch_updated_at();

-- Alias/synonym mapping. Spec 08 requires alias provenance and an explicit exact-vs-ambiguous
-- state, because "An LLM may propose a mapping but cannot invent/confirm a canonical identity
-- without validation."
CREATE TABLE substance_alias (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  substance_id   uuid NOT NULL REFERENCES normalized_substance (id) ON DELETE CASCADE,
  alias_text     text NOT NULL,
  alias_normalized text NOT NULL,
  provenance     text NOT NULL,
  mapping_state  text NOT NULL DEFAULT 'AMBIGUOUS',
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alias_mapping_state_valid
    CHECK (mapping_state IN ('EXACT', 'AMBIGUOUS', 'REJECTED')),
  CONSTRAINT alias_provenance_valid
    CHECK (provenance IN ('OFFICIAL_SOURCE', 'APPROVED_PROVIDER', 'REVIEWER_CONFIRMED',
                          'DETERMINISTIC_PARSER', 'PACKAGE_VISION_MODEL', 'IMPORTED'))
);

-- An alias may map to exactly one substance *as EXACT*; ambiguous aliases may fan out, which is
-- precisely how genuine ambiguity is represented rather than silently resolved.
CREATE UNIQUE INDEX substance_alias_exact_unique
  ON substance_alias (alias_normalized) WHERE mapping_state = 'EXACT';
CREATE INDEX substance_alias_lookup_idx ON substance_alias (alias_normalized);

-- ---------------------------------------------------------------------------
-- product_identity  (layer 1)
-- ---------------------------------------------------------------------------

CREATE TABLE product_identity (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_kind         text NOT NULL,
  brand             text,
  display_name      text NOT NULL,
  manufacturer      text,
  marketer          text,
  category          text,
  -- A GTIN is stored here as commercial identity only. Spec 08: "Never treat barcode as proof of
  -- formula, batch, expiry, or current label." A GTIN deliberately does NOT uniquely key this
  -- table, because one barcode can span reformulations and markets.
  gtin              text,
  corroboration     text NOT NULL DEFAULT 'CANDIDATE',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  retired_at        timestamptz,
  CONSTRAINT product_identity_kind_valid CHECK (item_kind IN ('MEDICINE', 'PERSONAL_CARE')),
  CONSTRAINT product_identity_name_not_blank CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT product_identity_corroboration_valid
    CHECK (corroboration IN ('CANDIDATE', 'USER_CONFIRMED', 'CORROBORATED',
                             'EXTERNALLY_VERIFIED', 'CONFLICTING', 'RETIRED')),
  -- GTIN-8/12/13/14 lengths only; the check digit is validated in the domain layer where a
  -- helpful error can be produced.
  CONSTRAINT product_identity_gtin_shape
    CHECK (gtin IS NULL OR gtin ~ '^[0-9]{8}$|^[0-9]{12}$|^[0-9]{13}$|^[0-9]{14}$')
);

CREATE INDEX product_identity_gtin_idx ON product_identity (gtin) WHERE gtin IS NOT NULL;
CREATE INDEX product_identity_brand_idx ON product_identity (lower(brand), lower(display_name));

CREATE TRIGGER product_identity_touch BEFORE UPDATE ON product_identity
  FOR EACH ROW EXECUTE FUNCTION kynviora.touch_updated_at();

-- ---------------------------------------------------------------------------
-- marketed_formulation  (layers 2 + 3)
-- ---------------------------------------------------------------------------
-- Spec 08: "Two label versions can coexist under one commercial product identity."
-- A reformulation creates a NEW row; it never updates an existing one. `superseded_by_id`
-- records the relationship so history stays navigable and Evidence Diff can render it.

CREATE TABLE marketed_formulation (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_identity_id   uuid NOT NULL REFERENCES product_identity (id) ON DELETE RESTRICT,
  market                text NOT NULL,
  version_label         text NOT NULL DEFAULT 'v1',

  -- Personal care: the declaration exactly as printed, plus the parsed ordered token list.
  -- Spec 05.1: "Raw label evidence is never overwritten by normalization."
  ingredient_declaration_raw text,
  ingredient_tokens     text[],

  -- Medicine: strength and form are material to identity. Spec 08: "A result missing material
  -- strength/form information is not an exact medicine match."
  active_ingredients    jsonb,
  strength_text         text,
  dosage_form           text,

  product_use_type      text NOT NULL DEFAULT 'UNKNOWN',

  -- Deterministic fingerprint (DEC-015). Versioned so the algorithm can evolve without
  -- rewriting history (spec 08).
  fingerprint           text NOT NULL,
  fingerprint_version   text NOT NULL,

  corroboration         text NOT NULL DEFAULT 'CANDIDATE',
  first_observed_at     timestamptz NOT NULL DEFAULT now(),
  last_observed_at      timestamptz NOT NULL DEFAULT now(),
  superseded_by_id      uuid REFERENCES marketed_formulation (id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT formulation_market_valid CHECK (market ~ '^[A-Z]{2}$'),
  CONSTRAINT formulation_use_type_valid
    CHECK (product_use_type IN ('RINSE_OFF', 'LEAVE_ON', 'ORAL', 'UNKNOWN')),
  CONSTRAINT formulation_corroboration_valid
    CHECK (corroboration IN ('CANDIDATE', 'USER_CONFIRMED', 'CORROBORATED',
                             'EXTERNALLY_VERIFIED', 'CONFLICTING', 'RETIRED')),
  CONSTRAINT formulation_not_self_superseding CHECK (superseded_by_id IS DISTINCT FROM id)
);

-- One formulation per fingerprint per product per market per algorithm version. This is what
-- makes the cache-hit path cheap (spec 08 cost model) while a *different* fingerprint under the
-- same identity naturally becomes a separate row rather than an overwrite.
CREATE UNIQUE INDEX marketed_formulation_fingerprint_unique
  ON marketed_formulation (product_identity_id, market, fingerprint, fingerprint_version);

CREATE INDEX marketed_formulation_lookup_idx
  ON marketed_formulation (fingerprint, fingerprint_version);
CREATE INDEX marketed_formulation_identity_idx
  ON marketed_formulation (product_identity_id, market);

CREATE TRIGGER marketed_formulation_touch BEFORE UPDATE ON marketed_formulation
  FOR EACH ROW EXECUTE FUNCTION kynviora.touch_updated_at();

-- Normalized ingredient links, preserving declaration order.
-- Spec 08: INCI declarations are ordered by decreasing concentration, so `position` is material
-- data, not presentation.
CREATE TABLE formulation_ingredient (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  formulation_id   uuid NOT NULL REFERENCES marketed_formulation (id) ON DELETE CASCADE,
  position         integer NOT NULL,
  raw_term         text NOT NULL,
  substance_id     uuid REFERENCES normalized_substance (id) ON DELETE SET NULL,
  mapping_state    text NOT NULL DEFAULT 'UNRESOLVED',
  -- Concentration is recorded ONLY when the package actually discloses it. Spec 09 requires
  -- CONDITION_UNKNOWN rather than an invented compliance judgement when it is absent, so this
  -- column stays NULL for the overwhelmingly common case.
  disclosed_concentration_percent numeric(6,3),
  CONSTRAINT formulation_ingredient_position_positive CHECK (position >= 0),
  CONSTRAINT formulation_ingredient_mapping_valid
    CHECK (mapping_state IN ('EXACT', 'AMBIGUOUS', 'UNRESOLVED')),
  CONSTRAINT formulation_ingredient_concentration_range
    CHECK (disclosed_concentration_percent IS NULL
           OR (disclosed_concentration_percent >= 0 AND disclosed_concentration_percent <= 100)),
  UNIQUE (formulation_id, position)
);

CREATE INDEX formulation_ingredient_substance_idx ON formulation_ingredient (substance_id);

-- ---------------------------------------------------------------------------
-- batch_or_lot  (layer 4)
-- ---------------------------------------------------------------------------

CREATE TABLE batch_or_lot (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  formulation_id   uuid REFERENCES marketed_formulation (id) ON DELETE SET NULL,
  product_identity_id uuid NOT NULL REFERENCES product_identity (id) ON DELETE RESTRICT,
  lot_code         text NOT NULL,
  lot_code_normalized text NOT NULL,
  manufactured_on  date,
  expires_on       date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT batch_lot_code_not_blank CHECK (length(btrim(lot_code)) > 0),
  CONSTRAINT batch_dates_ordered
    CHECK (manufactured_on IS NULL OR expires_on IS NULL OR expires_on >= manufactured_on)
);

CREATE INDEX batch_lookup_idx ON batch_or_lot (product_identity_id, lot_code_normalized);

-- ---------------------------------------------------------------------------
-- evidence_asset  (the captured image/document)
-- ---------------------------------------------------------------------------
-- Spec 16: raw user package images are private/internal evidence by default and are never
-- exposed to other users. Only the contributing user and the service role may read a row here.
-- Spec 13/14 require upload validation state to be recorded before processing.

CREATE TABLE evidence_asset (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id      uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  profile_id         uuid REFERENCES profile (id) ON DELETE SET NULL,
  panel_kind         text NOT NULL,
  storage_key        text NOT NULL UNIQUE,
  content_type       text NOT NULL,
  byte_size          bigint NOT NULL,
  sha256             text NOT NULL,
  -- Perceptual hash for duplicate-image detection, which spec 08 requires so duplicate or
  -- manipulated submissions cannot cheaply promote a formulation to CORROBORATED (threat A11).
  perceptual_hash    text,
  security_scan_state text NOT NULL DEFAULT 'PENDING',
  quality_state      text NOT NULL DEFAULT 'PENDING',
  metadata_stripped  boolean NOT NULL DEFAULT false,
  captured_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  CONSTRAINT evidence_panel_kind_valid CHECK (panel_kind IN (
    'FRONT_PANEL', 'INGREDIENT_PANEL', 'BARCODE_PANEL', 'BATCH_DATE_PANEL',
    'PRESCRIPTION', 'OTHER')),
  CONSTRAINT evidence_scan_state_valid
    CHECK (security_scan_state IN ('PENDING', 'CLEAN', 'REJECTED', 'FAILED')),
  CONSTRAINT evidence_quality_state_valid
    CHECK (quality_state IN ('PENDING', 'ACCEPTED', 'RETAKE_REQUIRED')),
  CONSTRAINT evidence_byte_size_positive CHECK (byte_size > 0),
  CONSTRAINT evidence_sha256_shape CHECK (sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX evidence_asset_owner_idx ON evidence_asset (owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX evidence_asset_phash_idx ON evidence_asset (perceptual_hash)
  WHERE perceptual_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- extraction_run and field_assertion
-- ---------------------------------------------------------------------------
-- Spec 07: "Model output itself is not shared catalog truth."

CREATE TABLE extraction_run (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_asset_id uuid NOT NULL REFERENCES evidence_asset (id) ON DELETE CASCADE,
  engine           text NOT NULL,
  engine_version   text NOT NULL,
  schema_version   text NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  outcome          text NOT NULL DEFAULT 'PENDING',
  CONSTRAINT extraction_engine_valid
    CHECK (engine IN ('BARCODE_DECODER', 'OCR', 'VISION_MODEL', 'DETERMINISTIC_PARSER')),
  CONSTRAINT extraction_outcome_valid
    CHECK (outcome IN ('PENDING', 'SUCCEEDED', 'FAILED', 'ABSTAINED'))
);

CREATE INDEX extraction_run_asset_idx ON extraction_run (evidence_asset_id);

-- Append-only (DEC-013). A correction inserts a new row referencing its predecessor.
CREATE TABLE field_assertion (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Assertions attach to whichever catalog subject they describe. Exactly one must be set.
  product_identity_id uuid REFERENCES product_identity (id) ON DELETE CASCADE,
  formulation_id     uuid REFERENCES marketed_formulation (id) ON DELETE CASCADE,
  batch_id           uuid REFERENCES batch_or_lot (id) ON DELETE CASCADE,

  field_path         text NOT NULL,
  raw_value          text,
  normalized_value   jsonb,
  provenance         text NOT NULL,

  evidence_asset_id  uuid REFERENCES evidence_asset (id) ON DELETE SET NULL,
  extraction_run_id  uuid REFERENCES extraction_run (id) ON DELETE SET NULL,
  source_region      jsonb,
  confidence         numeric(4,3),

  validation_outcome text NOT NULL DEFAULT 'NOT_RUN',
  validator          text,
  validator_version  text,
  confirmation       text NOT NULL DEFAULT 'UNCONFIRMED',
  extractor_version  text NOT NULL,

  asserted_at        timestamptz NOT NULL DEFAULT now(),
  supersedes_id      uuid REFERENCES field_assertion (id) ON DELETE SET NULL,

  CONSTRAINT field_assertion_one_subject CHECK (
    (product_identity_id IS NOT NULL)::int
    + (formulation_id IS NOT NULL)::int
    + (batch_id IS NOT NULL)::int = 1
  ),
  CONSTRAINT field_assertion_provenance_valid CHECK (provenance IN (
    'USER_REPORTED', 'CAREGIVER_ENTERED', 'USER_CONFIRMED_FROM_PACKAGE', 'PACKAGE_OCR',
    'PACKAGE_VISION_MODEL', 'BARCODE_DECODE', 'DETERMINISTIC_PARSER', 'APPROVED_PROVIDER',
    'MANUFACTURER_EVIDENCE', 'OFFICIAL_SOURCE', 'REVIEWER_CONFIRMED', 'IMPORTED')),
  CONSTRAINT field_assertion_validation_valid
    CHECK (validation_outcome IN ('PASSED', 'FAILED', 'NOT_APPLICABLE', 'NOT_RUN')),
  CONSTRAINT field_assertion_confirmation_valid
    CHECK (confirmation IN ('UNCONFIRMED', 'USER_CONFIRMED', 'USER_CORRECTED',
                            'REVIEWER_CONFIRMED', 'AUTO_VALIDATED', 'REJECTED')),
  CONSTRAINT field_assertion_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT field_assertion_not_self_superseding CHECK (supersedes_id IS DISTINCT FROM id)
);

CREATE INDEX field_assertion_subject_idx
  ON field_assertion (product_identity_id, formulation_id, batch_id, field_path);
CREATE INDEX field_assertion_supersedes_idx ON field_assertion (supersedes_id)
  WHERE supersedes_id IS NOT NULL;

CREATE TRIGGER field_assertion_append_only
  BEFORE UPDATE OR DELETE ON field_assertion
  FOR EACH ROW EXECUTE FUNCTION kynviora.forbid_mutation();

-- ---------------------------------------------------------------------------
-- product_observation  (layer 5)
-- ---------------------------------------------------------------------------
-- Spec 07: "may be tied privately to a user submission but shared catalog projections must not
-- expose the contributing user's identity/health context."

CREATE TABLE product_observation (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_identity_id uuid NOT NULL REFERENCES product_identity (id) ON DELETE CASCADE,
  formulation_id      uuid REFERENCES marketed_formulation (id) ON DELETE SET NULL,
  batch_id            uuid REFERENCES batch_or_lot (id) ON DELETE SET NULL,
  market              text NOT NULL,
  observed_at         timestamptz NOT NULL DEFAULT now(),

  -- Private contributor linkage. Retained only for abuse handling, correction and retention
  -- policy (spec 16), and never exposed through shared catalog reads.
  contributed_by_user_id uuid REFERENCES app_user (id) ON DELETE SET NULL,
  -- Device/session grouping used purely to judge observation independence (spec 08). Hashed by
  -- the application; never a raw device identifier.
  contribution_group_hash text,

  evidence_asset_id   uuid REFERENCES evidence_asset (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT observation_market_valid CHECK (market ~ '^[A-Z]{2}$')
);

CREATE INDEX product_observation_formulation_idx
  ON product_observation (formulation_id, observed_at DESC);
CREATE INDEX product_observation_contributor_idx
  ON product_observation (contributed_by_user_id);
CREATE INDEX product_observation_group_idx ON product_observation (contribution_group_hash);

CREATE TRIGGER product_observation_append_only
  BEFORE UPDATE OR DELETE ON product_observation
  FOR EACH ROW EXECUTE FUNCTION kynviora.forbid_mutation();

-- ---------------------------------------------------------------------------
-- catalog_conflict
-- ---------------------------------------------------------------------------
-- Spec 08: a material disagreement creates a conflict record; it never overwrites a formulation.

CREATE TABLE catalog_conflict (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_identity_id   uuid NOT NULL REFERENCES product_identity (id) ON DELETE CASCADE,
  existing_formulation_id uuid NOT NULL REFERENCES marketed_formulation (id) ON DELETE CASCADE,
  candidate_formulation_id uuid REFERENCES marketed_formulation (id) ON DELETE SET NULL,
  conflict_kind         text NOT NULL,
  affected_fields       text[] NOT NULL DEFAULT ARRAY[]::text[],
  detail                jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_state          text NOT NULL DEFAULT 'CANDIDATE',
  resolution            text,
  detected_at           timestamptz NOT NULL DEFAULT now(),
  resolved_at           timestamptz,
  CONSTRAINT conflict_kind_valid CHECK (conflict_kind IN (
    'INGREDIENT_DECLARATION_CHANGED', 'STRENGTH_CHANGED', 'DOSAGE_FORM_CHANGED',
    'MANUFACTURER_CHANGED', 'PROVIDER_DISAGREEMENT', 'EXTRACTION_DISAGREEMENT')),
  CONSTRAINT conflict_review_state_valid
    CHECK (review_state IN ('CANDIDATE', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'REJECTED',
                            'SUPERSEDED', 'WITHDRAWN')),
  CONSTRAINT conflict_resolution_valid CHECK (resolution IS NULL OR resolution IN (
    'NEW_FORMULATION_VERSION', 'CORRECTED_EXISTING', 'REJECTED_OBSERVATION',
    'PARALLEL_VARIANT', 'UNRESOLVED'))
);

CREATE INDEX catalog_conflict_identity_idx ON catalog_conflict (product_identity_id, review_state);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

ALTER TABLE normalized_substance ENABLE ROW LEVEL SECURITY;
ALTER TABLE normalized_substance FORCE ROW LEVEL SECURITY;
ALTER TABLE substance_alias ENABLE ROW LEVEL SECURITY;
ALTER TABLE substance_alias FORCE ROW LEVEL SECURITY;
ALTER TABLE product_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_identity FORCE ROW LEVEL SECURITY;
ALTER TABLE marketed_formulation ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketed_formulation FORCE ROW LEVEL SECURITY;
ALTER TABLE formulation_ingredient ENABLE ROW LEVEL SECURITY;
ALTER TABLE formulation_ingredient FORCE ROW LEVEL SECURITY;
ALTER TABLE batch_or_lot ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_or_lot FORCE ROW LEVEL SECURITY;
ALTER TABLE evidence_asset ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_asset FORCE ROW LEVEL SECURITY;
ALTER TABLE extraction_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE extraction_run FORCE ROW LEVEL SECURITY;
ALTER TABLE field_assertion ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_assertion FORCE ROW LEVEL SECURITY;
ALTER TABLE product_observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_observation FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog_conflict ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_conflict FORCE ROW LEVEL SECURITY;

-- SHARED CATALOG: readable by any authenticated user, writable ONLY by the service role.
-- This is the privilege-level enforcement of spec 03 group K and threat A11.
GRANT SELECT ON normalized_substance, substance_alias, product_identity, marketed_formulation,
                formulation_ingredient, batch_or_lot, catalog_conflict TO kynviora_app;
GRANT SELECT, INSERT, UPDATE ON normalized_substance, substance_alias, product_identity,
                marketed_formulation, formulation_ingredient, batch_or_lot, catalog_conflict
                TO kynviora_service;

GRANT SELECT, INSERT, UPDATE ON evidence_asset TO kynviora_app;
GRANT SELECT, INSERT, UPDATE ON evidence_asset TO kynviora_service;
GRANT SELECT ON extraction_run, field_assertion, product_observation TO kynviora_app;
GRANT SELECT, INSERT ON extraction_run, field_assertion, product_observation TO kynviora_service;

-- Shared catalog reads are unrestricted for authenticated users; these tables hold product
-- knowledge only, never personal health context.
CREATE POLICY substance_read ON normalized_substance
  FOR SELECT TO kynviora_app USING (kynviora.current_user_id() IS NOT NULL);
CREATE POLICY substance_service ON normalized_substance
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

CREATE POLICY alias_read ON substance_alias
  FOR SELECT TO kynviora_app USING (kynviora.current_user_id() IS NOT NULL);
CREATE POLICY alias_service ON substance_alias
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

CREATE POLICY product_identity_read ON product_identity
  FOR SELECT TO kynviora_app USING (kynviora.current_user_id() IS NOT NULL);
CREATE POLICY product_identity_service ON product_identity
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

CREATE POLICY formulation_read ON marketed_formulation
  FOR SELECT TO kynviora_app USING (kynviora.current_user_id() IS NOT NULL);
CREATE POLICY formulation_service ON marketed_formulation
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

CREATE POLICY formulation_ingredient_read ON formulation_ingredient
  FOR SELECT TO kynviora_app USING (kynviora.current_user_id() IS NOT NULL);
CREATE POLICY formulation_ingredient_service ON formulation_ingredient
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

CREATE POLICY batch_read ON batch_or_lot
  FOR SELECT TO kynviora_app USING (kynviora.current_user_id() IS NOT NULL);
CREATE POLICY batch_service ON batch_or_lot
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

CREATE POLICY conflict_read ON catalog_conflict
  FOR SELECT TO kynviora_app USING (kynviora.current_user_id() IS NOT NULL);
CREATE POLICY conflict_service ON catalog_conflict
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

-- EVIDENCE ASSETS: strictly private to the contributing user (spec 16). Another user must never
-- read a raw package image, even though structured facts derived from it may reach the shared
-- catalog.
CREATE POLICY evidence_owner_select ON evidence_asset
  FOR SELECT TO kynviora_app
  USING (owner_user_id = kynviora.current_user_id() AND deleted_at IS NULL);

CREATE POLICY evidence_owner_insert ON evidence_asset
  FOR INSERT TO kynviora_app
  WITH CHECK (owner_user_id = kynviora.current_user_id());

CREATE POLICY evidence_owner_update ON evidence_asset
  FOR UPDATE TO kynviora_app
  USING (owner_user_id = kynviora.current_user_id())
  WITH CHECK (owner_user_id = kynviora.current_user_id());

CREATE POLICY evidence_service ON evidence_asset
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

-- EXTRACTION RUNS: visible only through an evidence asset the user owns.
CREATE POLICY extraction_run_read ON extraction_run
  FOR SELECT TO kynviora_app
  USING (EXISTS (
    SELECT 1 FROM evidence_asset a
    WHERE a.id = extraction_run.evidence_asset_id
      AND a.owner_user_id = kynviora.current_user_id()
  ));
CREATE POLICY extraction_run_service ON extraction_run
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

-- FIELD ASSERTIONS: readable as shared catalog provenance, because the Product Trust Passport
-- and "Why am I seeing this?" inspector need them. They carry product facts and extractor
-- versions - never profile context. The linked evidence_asset stays private regardless.
CREATE POLICY field_assertion_read ON field_assertion
  FOR SELECT TO kynviora_app USING (kynviora.current_user_id() IS NOT NULL);
CREATE POLICY field_assertion_service ON field_assertion
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

-- PRODUCT OBSERVATIONS: the contributor linkage is the privacy-sensitive part (spec 16), so a
-- user may read only their own observation rows. Aggregate corroboration counts are exposed
-- through a separate view that carries no contributor identity.
CREATE POLICY observation_own_read ON product_observation
  FOR SELECT TO kynviora_app
  USING (contributed_by_user_id = kynviora.current_user_id());
CREATE POLICY observation_service ON product_observation
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

-- Contributor-free corroboration projection. Spec 08: "Raw user identities and health profiles
-- are never exposed as catalog corroboration evidence to other users."
CREATE VIEW formulation_corroboration_summary
WITH (security_invoker = false) AS
  SELECT
    f.id                                        AS formulation_id,
    f.product_identity_id,
    f.market,
    f.corroboration,
    f.fingerprint,
    f.fingerprint_version,
    f.first_observed_at,
    f.last_observed_at,
    count(o.id)                                 AS observation_count,
    count(DISTINCT o.contribution_group_hash)   AS independent_group_count
  FROM marketed_formulation f
  LEFT JOIN product_observation o ON o.formulation_id = f.id
  GROUP BY f.id;

GRANT SELECT ON formulation_corroboration_summary TO kynviora_app, kynviora_service;

COMMENT ON VIEW formulation_corroboration_summary IS
  'Corroboration counts with no contributor identity. security_invoker=false so the aggregate '
  'is computed without exposing product_observation rows to the querying user (spec 08, 16).';
