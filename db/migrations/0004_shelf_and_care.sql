-- 0004_shelf_and_care.sql
-- Profile health context, the Unified Health Shelf, and medicine care records.
--
-- Spec references: 04 Stage 1.3, Stage 2, Stage 4; 07 (profile context, user-owned item,
-- medicine care domains); 16 (data minimisation).
--
-- THE OWNERSHIP BOUNDARY
-- Everything here is personal health data belonging to exactly one profile. Access flows through
-- kynviora.has_capability(), so a caregiver reaches it only with the specific capability the
-- profile owner granted - VIEW_SHELF is not VIEW_MEDICINES, and neither is MANAGE_ anything.
--
-- SEPARATION FROM THE SHARED CATALOG
-- An OwnedItem references catalog records but is never the same row. Spec 07: changing shared
-- catalog knowledge must not silently change what package the user actually recorded, which is
-- why product_usage_evidence pins the exact formulation and batch the user confirmed.

-- ---------------------------------------------------------------------------
-- Profile health context (Phase 1.3)
-- ---------------------------------------------------------------------------
-- Spec 16 data minimisation: only the narrow context the approved MVP rules need.

CREATE TABLE allergy_record (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id        uuid NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
  record_kind       text NOT NULL,
  -- What the user actually said, preserved verbatim.
  display_term      text NOT NULL,
  -- Canonical mapping when one exists. NULL is normal and is meaningful: an unmapped term
  -- cannot drive a rule that matches on canonical substances (spec 04 Phase 5.2).
  substance_id      uuid REFERENCES normalized_substance (id) ON DELETE SET NULL,
  provenance        text NOT NULL,
  certainty         text NOT NULL DEFAULT 'REPORTED',
  noted_on          date,
  last_reviewed_at  timestamptz,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CONSTRAINT allergy_kind_valid CHECK (record_kind IN ('ALLERGY', 'SENSITIVITY')),
  CONSTRAINT allergy_term_not_blank CHECK (length(btrim(display_term)) > 0),
  CONSTRAINT allergy_provenance_valid CHECK (provenance IN (
    'USER_REPORTED', 'CAREGIVER_ENTERED', 'IMPORTED', 'REVIEWER_CONFIRMED')),
  -- Spec 04 Phase 1.3: "No OCR or inferred fact silently becomes a confirmed diagnosis."
  -- CLINICIAN_CONFIRMED is deliberately absent from provenance until a verified source exists.
  CONSTRAINT allergy_certainty_valid CHECK (certainty IN ('REPORTED', 'SUSPECTED', 'CONFIRMED'))
);

CREATE INDEX allergy_profile_idx ON allergy_record (profile_id) WHERE deleted_at IS NULL;

CREATE TRIGGER allergy_touch BEFORE UPDATE ON allergy_record
  FOR EACH ROW EXECUTE FUNCTION kynviora.touch_updated_at();

CREATE TABLE condition_record (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id       uuid NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
  display_term     text NOT NULL,
  provenance       text NOT NULL,
  certainty        text NOT NULL DEFAULT 'REPORTED',
  noted_on         date,
  last_reviewed_at timestamptz,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CONSTRAINT condition_term_not_blank CHECK (length(btrim(display_term)) > 0),
  CONSTRAINT condition_provenance_valid CHECK (provenance IN (
    'USER_REPORTED', 'CAREGIVER_ENTERED', 'IMPORTED', 'REVIEWER_CONFIRMED')),
  CONSTRAINT condition_certainty_valid CHECK (certainty IN ('REPORTED', 'SUSPECTED', 'CONFIRMED'))
);

CREATE INDEX condition_profile_idx ON condition_record (profile_id) WHERE deleted_at IS NULL;

CREATE TRIGGER condition_touch BEFORE UPDATE ON condition_record
  FOR EACH ROW EXECUTE FUNCTION kynviora.touch_updated_at();

-- ---------------------------------------------------------------------------
-- owned_item  (layer 6 - the Unified Health Shelf)
-- ---------------------------------------------------------------------------
-- Spec 04 Stage 2: medicines and personal-care items coexist without either being reduced to a
-- generic note, so category-specific fields live alongside the shared lifecycle.

CREATE TABLE owned_item (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id          uuid NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
  item_kind           text NOT NULL,

  -- Catalog linkage. All nullable: spec 04 Phase 2.2 requires a clinically useful record to be
  -- creatable entirely manually, with missing fields staying explicitly unknown.
  product_identity_id uuid REFERENCES product_identity (id) ON DELETE SET NULL,
  formulation_id      uuid REFERENCES marketed_formulation (id) ON DELETE SET NULL,
  batch_id            uuid REFERENCES batch_or_lot (id) ON DELETE SET NULL,

  -- User-visible naming, which may differ from the catalog record (a user may label their own
  -- pack). Preserved so the Shelf reads the way the user expects.
  display_name        text NOT NULL,
  brand               text,
  market              text,

  -- Medicine-specific.
  strength_text       text,
  dosage_form         text,
  -- Written directions exactly as prescribed or printed. Spec 04 Phase 4.1 requires these
  -- preserved as source text; Kynviora never rewrites a prescription instruction.
  directions_text     text,

  -- Personal-care specific.
  personal_care_category text,

  -- Verification, tracked separately per facet (spec 08 Product Trust Passport).
  identity_verification    text NOT NULL DEFAULT 'UNVERIFIED',
  formulation_verification text NOT NULL DEFAULT 'UNVERIFIED',
  batch_verification       text NOT NULL DEFAULT 'UNVERIFIED',

  -- Lifecycle.
  lifecycle_state     text NOT NULL DEFAULT 'ACTIVE',
  started_on          date,
  stopped_on          date,
  expires_on          date,
  last_reviewed_at    timestamptz,
  last_safety_checked_at timestamptz,

  notes               text,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,

  CONSTRAINT owned_item_kind_valid CHECK (item_kind IN ('MEDICINE', 'PERSONAL_CARE')),
  CONSTRAINT owned_item_name_not_blank CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT owned_item_market_valid CHECK (market IS NULL OR market ~ '^[A-Z]{2}$'),
  CONSTRAINT owned_item_lifecycle_valid
    CHECK (lifecycle_state IN ('ACTIVE', 'STOPPED', 'ARCHIVED')),
  CONSTRAINT owned_item_identity_verification_valid
    CHECK (identity_verification IN ('CONFIRMED','PROBABLE','PARTIAL','CONFLICTING','UNVERIFIED')),
  CONSTRAINT owned_item_formulation_verification_valid
    CHECK (formulation_verification IN ('CONFIRMED','PROBABLE','PARTIAL','CONFLICTING','UNVERIFIED')),
  CONSTRAINT owned_item_batch_verification_valid
    CHECK (batch_verification IN ('CONFIRMED','PROBABLE','PARTIAL','CONFLICTING','UNVERIFIED')),
  CONSTRAINT owned_item_personal_care_category_valid CHECK (
    personal_care_category IS NULL OR personal_care_category IN
      ('SKIN_CARE','SUNSCREEN','HAIR_CARE','BODY_CLEANSER','ORAL_CARE','COSMETIC_TOPICAL')),
  -- A personal-care category on a medicine, or a dosage form on a shampoo, indicates a data
  -- error worth catching at write time.
  CONSTRAINT owned_item_category_matches_kind CHECK (
    (item_kind = 'PERSONAL_CARE' AND dosage_form IS NULL AND strength_text IS NULL)
    OR (item_kind = 'MEDICINE' AND personal_care_category IS NULL)
  ),
  CONSTRAINT owned_item_dates_ordered
    CHECK (stopped_on IS NULL OR started_on IS NULL OR stopped_on >= started_on)
);

CREATE INDEX owned_item_profile_idx ON owned_item (profile_id, lifecycle_state)
  WHERE deleted_at IS NULL;
CREATE INDEX owned_item_formulation_idx ON owned_item (formulation_id)
  WHERE formulation_id IS NOT NULL AND deleted_at IS NULL;
-- Supports the batch-recall matching path: find every owned item on an affected batch.
CREATE INDEX owned_item_batch_idx ON owned_item (batch_id)
  WHERE batch_id IS NOT NULL AND deleted_at IS NULL;

CREATE TRIGGER owned_item_touch BEFORE UPDATE ON owned_item
  FOR EACH ROW EXECUTE FUNCTION kynviora.touch_updated_at();

-- ---------------------------------------------------------------------------
-- product_usage_evidence
-- ---------------------------------------------------------------------------
-- Spec 07: "distinct from the shared catalog observation so changing shared catalog knowledge
-- does not silently change what package the user actually recorded."
-- Append-only: this is the user's own record of what they held.

CREATE TABLE product_usage_evidence (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owned_item_id      uuid NOT NULL REFERENCES owned_item (id) ON DELETE CASCADE,
  formulation_id     uuid REFERENCES marketed_formulation (id) ON DELETE SET NULL,
  batch_id           uuid REFERENCES batch_or_lot (id) ON DELETE SET NULL,
  evidence_asset_id  uuid REFERENCES evidence_asset (id) ON DELETE SET NULL,
  observation_id     uuid REFERENCES product_observation (id) ON DELETE SET NULL,
  confirmed_at       timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX product_usage_evidence_item_idx
  ON product_usage_evidence (owned_item_id, confirmed_at DESC);

CREATE TRIGGER product_usage_evidence_append_only
  BEFORE UPDATE OR DELETE ON product_usage_evidence
  FOR EACH ROW EXECUTE FUNCTION kynviora.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Medicine care (Stage 4)
-- ---------------------------------------------------------------------------

CREATE TABLE medicine_schedule (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owned_item_id    uuid NOT NULL REFERENCES owned_item (id) ON DELETE CASCADE,
  schedule_kind    text NOT NULL,
  -- Local times in HH:MM. Stored separately from the timezone so a device timezone change does
  -- not silently move a dose (spec 04 Phase 4.1 time-zone handling).
  times_local      text[] NOT NULL DEFAULT ARRAY[]::text[],
  -- ISO-8601 weekday numbers, 1 = Monday.
  days_of_week     integer[],
  timezone         text NOT NULL DEFAULT 'Asia/Kolkata',
  starts_on        date,
  ends_on          date,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedule_kind_valid
    CHECK (schedule_kind IN ('FIXED_TIMES', 'SELECTED_DAYS', 'AS_NEEDED')),
  -- Spec 04 Phase 4.1 requires as-needed to be separated from fixed reminders, so an as-needed
  -- entry must not carry scheduled times that a reminder engine would fire on.
  CONSTRAINT schedule_as_needed_has_no_times
    CHECK (schedule_kind <> 'AS_NEEDED' OR cardinality(times_local) = 0),
  CONSTRAINT schedule_fixed_has_times
    CHECK (schedule_kind = 'AS_NEEDED' OR cardinality(times_local) > 0),
  -- Every element must be a 24-hour HH:MM. Expressed as a regex over the joined array because
  -- a CHECK constraint may not contain a subquery, and this keeps the rule immutable and
  -- inspectable without adding a helper function.
  CONSTRAINT schedule_times_well_formed CHECK (
    array_to_string(times_local, ',') ~
      '^$|^([01][0-9]|2[0-3]):[0-5][0-9](,([01][0-9]|2[0-3]):[0-5][0-9])*$'
  ),
  CONSTRAINT schedule_days_valid
    CHECK (days_of_week IS NULL OR days_of_week <@ ARRAY[1,2,3,4,5,6,7]),
  CONSTRAINT schedule_dates_ordered
    CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);

CREATE INDEX medicine_schedule_item_idx ON medicine_schedule (owned_item_id) WHERE active;

CREATE TRIGGER medicine_schedule_touch BEFORE UPDATE ON medicine_schedule
  FOR EACH ROW EXECUTE FUNCTION kynviora.touch_updated_at();

-- Dose events. Spec 13 conflict policy: "dose events: merge by event ID". The client-supplied
-- operation ID is the idempotency key, so an offline retry cannot create a duplicate.
CREATE TABLE dose_event (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owned_item_id     uuid NOT NULL REFERENCES owned_item (id) ON DELETE CASCADE,
  schedule_id       uuid REFERENCES medicine_schedule (id) ON DELETE SET NULL,
  event_kind        text NOT NULL,
  scheduled_for     timestamptz,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  -- Neutral, optional. Spec 04 Phase 4.3 and spec 18 forbid shaming copy; nothing here scores
  -- or judges adherence.
  note              text,
  client_operation_id uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dose_event_kind_valid
    CHECK (event_kind IN ('TAKEN', 'SKIPPED', 'SNOOZED', 'UNABLE_TO_TAKE'))
);

-- The idempotency guarantee: a retried upload commits exactly once (spec 13).
CREATE UNIQUE INDEX dose_event_idempotency ON dose_event (client_operation_id);
CREATE INDEX dose_event_item_idx ON dose_event (owned_item_id, recorded_at DESC);

CREATE TRIGGER dose_event_append_only
  BEFORE UPDATE OR DELETE ON dose_event
  FOR EACH ROW EXECUTE FUNCTION kynviora.forbid_mutation();

-- Refill estimates. Spec 04 Phase 4.4: labelled estimates with user-adjustable assumptions,
-- never presented as pharmacy inventory truth.
CREATE TABLE refill_estimate (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owned_item_id    uuid NOT NULL REFERENCES owned_item (id) ON DELETE CASCADE,
  quantity_remaining numeric(10,2),
  doses_per_day    numeric(6,2),
  estimated_depletion_on date,
  assumptions_note text,
  computed_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refill_quantity_non_negative
    CHECK (quantity_remaining IS NULL OR quantity_remaining >= 0),
  CONSTRAINT refill_doses_positive CHECK (doses_per_day IS NULL OR doses_per_day > 0)
);

CREATE INDEX refill_estimate_item_idx ON refill_estimate (owned_item_id, computed_at DESC);

-- ---------------------------------------------------------------------------
-- review_task  (Phase 8.3 - Household Review Inbox)
-- ---------------------------------------------------------------------------
-- Spec 04 Phase 8.3: "Review tasks are clearly different from safety alerts." They live in their
-- own table with their own vocabulary and carry no urgency or evidence level at all.

CREATE TABLE review_task (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id     uuid NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
  owned_item_id  uuid REFERENCES owned_item (id) ON DELETE CASCADE,
  task_kind      text NOT NULL,
  state          text NOT NULL DEFAULT 'OPEN',
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  CONSTRAINT review_task_kind_valid CHECK (task_kind IN (
    'ITEM_NOT_REVIEWED_RECENTLY', 'BATCH_MISSING', 'FORMULA_NEEDS_CONFIRMATION',
    'OCR_FIELD_UNRESOLVED', 'CAREGIVER_GRANT_EXPIRING', 'SAFETY_ITEM_AWAITING_CONFIRMATION',
    'REFILL_ESTIMATE_NEEDS_REVIEW')),
  CONSTRAINT review_task_state_valid CHECK (state IN ('OPEN', 'COMPLETED', 'DISMISSED'))
);

CREATE INDEX review_task_profile_idx ON review_task (profile_id, state);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

ALTER TABLE allergy_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE allergy_record FORCE ROW LEVEL SECURITY;
ALTER TABLE condition_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE condition_record FORCE ROW LEVEL SECURITY;
ALTER TABLE owned_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE owned_item FORCE ROW LEVEL SECURITY;
ALTER TABLE product_usage_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_usage_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE medicine_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE medicine_schedule FORCE ROW LEVEL SECURITY;
ALTER TABLE dose_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE dose_event FORCE ROW LEVEL SECURITY;
ALTER TABLE refill_estimate ENABLE ROW LEVEL SECURITY;
ALTER TABLE refill_estimate FORCE ROW LEVEL SECURITY;
ALTER TABLE review_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_task FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON allergy_record, condition_record, owned_item,
      medicine_schedule, refill_estimate, review_task TO kynviora_app;
GRANT SELECT, INSERT ON product_usage_evidence, dose_event TO kynviora_app;

GRANT SELECT, INSERT, UPDATE ON allergy_record, condition_record, owned_item,
      medicine_schedule, refill_estimate, review_task TO kynviora_service;
GRANT SELECT, INSERT ON product_usage_evidence, dose_event TO kynviora_service;

-- Health context requires the medicines capability: it is the most sensitive profile data and
-- spec 08.2 requires a caregiver's safety-alert permission to be separate from data access.
CREATE POLICY allergy_select ON allergy_record
  FOR SELECT TO kynviora_app
  USING (deleted_at IS NULL AND kynviora.has_capability(profile_id, 'VIEW_MEDICINES'));
CREATE POLICY allergy_insert ON allergy_record
  FOR INSERT TO kynviora_app
  WITH CHECK (kynviora.has_capability(profile_id, 'MANAGE_MEDICINES'));
CREATE POLICY allergy_update ON allergy_record
  FOR UPDATE TO kynviora_app
  USING (kynviora.has_capability(profile_id, 'MANAGE_MEDICINES'))
  WITH CHECK (kynviora.has_capability(profile_id, 'MANAGE_MEDICINES'));
CREATE POLICY allergy_service ON allergy_record
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

CREATE POLICY condition_select ON condition_record
  FOR SELECT TO kynviora_app
  USING (deleted_at IS NULL AND kynviora.has_capability(profile_id, 'VIEW_MEDICINES'));
CREATE POLICY condition_insert ON condition_record
  FOR INSERT TO kynviora_app
  WITH CHECK (kynviora.has_capability(profile_id, 'MANAGE_MEDICINES'));
CREATE POLICY condition_update ON condition_record
  FOR UPDATE TO kynviora_app
  USING (kynviora.has_capability(profile_id, 'MANAGE_MEDICINES'))
  WITH CHECK (kynviora.has_capability(profile_id, 'MANAGE_MEDICINES'));
CREATE POLICY condition_service ON condition_record
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

-- Shelf items: VIEW_SHELF reads, MANAGE_SHELF writes. A medicine additionally requires the
-- medicines capability, so a caregiver granted only shelf access cannot read the medicine list.
CREATE POLICY owned_item_select ON owned_item
  FOR SELECT TO kynviora_app
  USING (
    deleted_at IS NULL
    AND (
      (item_kind = 'PERSONAL_CARE' AND kynviora.has_capability(profile_id, 'VIEW_SHELF'))
      OR (item_kind = 'MEDICINE' AND kynviora.has_capability(profile_id, 'VIEW_MEDICINES'))
    )
  );

CREATE POLICY owned_item_insert ON owned_item
  FOR INSERT TO kynviora_app
  WITH CHECK (
    (item_kind = 'PERSONAL_CARE' AND kynviora.has_capability(profile_id, 'MANAGE_SHELF'))
    OR (item_kind = 'MEDICINE' AND kynviora.has_capability(profile_id, 'MANAGE_MEDICINES'))
  );

CREATE POLICY owned_item_update ON owned_item
  FOR UPDATE TO kynviora_app
  USING (
    deleted_at IS NULL
    AND (
      (item_kind = 'PERSONAL_CARE' AND kynviora.has_capability(profile_id, 'MANAGE_SHELF'))
      OR (item_kind = 'MEDICINE' AND kynviora.has_capability(profile_id, 'MANAGE_MEDICINES'))
    )
  )
  WITH CHECK (
    (item_kind = 'PERSONAL_CARE' AND kynviora.has_capability(profile_id, 'MANAGE_SHELF'))
    OR (item_kind = 'MEDICINE' AND kynviora.has_capability(profile_id, 'MANAGE_MEDICINES'))
  );

CREATE POLICY owned_item_service ON owned_item
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

-- Child records inherit reachability from their owned item, so there is exactly one place where
-- shelf access is decided.
CREATE POLICY usage_evidence_select ON product_usage_evidence
  FOR SELECT TO kynviora_app
  USING (EXISTS (SELECT 1 FROM owned_item i WHERE i.id = owned_item_id));
CREATE POLICY usage_evidence_insert ON product_usage_evidence
  FOR INSERT TO kynviora_app
  WITH CHECK (EXISTS (SELECT 1 FROM owned_item i WHERE i.id = owned_item_id));
CREATE POLICY usage_evidence_service ON product_usage_evidence
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

CREATE POLICY schedule_select ON medicine_schedule
  FOR SELECT TO kynviora_app
  USING (EXISTS (SELECT 1 FROM owned_item i WHERE i.id = owned_item_id));
CREATE POLICY schedule_insert ON medicine_schedule
  FOR INSERT TO kynviora_app
  WITH CHECK (EXISTS (SELECT 1 FROM owned_item i WHERE i.id = owned_item_id));
CREATE POLICY schedule_update ON medicine_schedule
  FOR UPDATE TO kynviora_app
  USING (EXISTS (SELECT 1 FROM owned_item i WHERE i.id = owned_item_id))
  WITH CHECK (EXISTS (SELECT 1 FROM owned_item i WHERE i.id = owned_item_id));
CREATE POLICY schedule_service ON medicine_schedule
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

CREATE POLICY dose_event_select ON dose_event
  FOR SELECT TO kynviora_app
  USING (EXISTS (SELECT 1 FROM owned_item i WHERE i.id = owned_item_id));
CREATE POLICY dose_event_insert ON dose_event
  FOR INSERT TO kynviora_app
  WITH CHECK (EXISTS (SELECT 1 FROM owned_item i WHERE i.id = owned_item_id));
CREATE POLICY dose_event_service ON dose_event
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

CREATE POLICY refill_select ON refill_estimate
  FOR SELECT TO kynviora_app
  USING (EXISTS (SELECT 1 FROM owned_item i WHERE i.id = owned_item_id));
CREATE POLICY refill_insert ON refill_estimate
  FOR INSERT TO kynviora_app
  WITH CHECK (EXISTS (SELECT 1 FROM owned_item i WHERE i.id = owned_item_id));
CREATE POLICY refill_update ON refill_estimate
  FOR UPDATE TO kynviora_app
  USING (EXISTS (SELECT 1 FROM owned_item i WHERE i.id = owned_item_id))
  WITH CHECK (EXISTS (SELECT 1 FROM owned_item i WHERE i.id = owned_item_id));
CREATE POLICY refill_service ON refill_estimate
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

CREATE POLICY review_task_select ON review_task
  FOR SELECT TO kynviora_app
  USING (kynviora.has_capability(profile_id, 'VIEW_CARE'));
CREATE POLICY review_task_insert ON review_task
  FOR INSERT TO kynviora_app
  WITH CHECK (kynviora.has_capability(profile_id, 'MANAGE_CARE'));
CREATE POLICY review_task_update ON review_task
  FOR UPDATE TO kynviora_app
  USING (kynviora.has_capability(profile_id, 'MANAGE_CARE'))
  WITH CHECK (kynviora.has_capability(profile_id, 'MANAGE_CARE'));
CREATE POLICY review_task_service ON review_task
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);
