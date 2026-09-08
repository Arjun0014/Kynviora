-- 0032_health_records.sql
-- The Health record: what Kynviora knows about a person, where it came from, and what changed.
--
-- Spec references: `06` (amended by DEC-151: Health is a primary destination), `07` (domain
-- model), `09` (evidence model - a source fact and a Kynviora conclusion are different things),
-- `10` (clinical governance), `14` (least privilege), `16` (retention), `18` (an absence is
-- legible as an absence), DEC-116 (a new capability backfills nothing), DEC-151, DEC-154.
--
-- WHAT THIS ADDS AND WHY IT IS FOUR TABLES
-- V3 makes Health a record rather than a metrics dashboard, with four addressable layers -
-- Profile, Records, Trends, History. Three of those need storage that did not exist:
--
--   health_source        Where a fact came from, and the honest state of that origin. A document
--                        imported once is not a live connection; a scale with no entry in three
--                        weeks is stale, not agreeing.
--   health_record        A clinical or personal record: a lab report, an annual check, a letter,
--                        a vaccination. Structured summary first, original document second.
--   health_observation   One structured result inside a record. An analyte, a value, a unit, and
--                        - only where the report gave them - a reference interval and a flag.
--   health_measurement   A point in a time series: a blood pressure, a weight, a resting heart
--                        rate. What Trends is drawn from.
--
-- Allergies and conditions already exist (`0004`) and are **not** moved. They are recorded facts
-- rather than documents, the Health screen says so where it lists them, and moving a table that
-- four other systems read to tidy a navigation change would be the wrong trade twice over.
--
-- THE RULE THIS SCHEMA IS BUILT AROUND
-- `09` and `10` forbid Kynviora from turning a measurement into a medical conclusion, and `02`
-- forbids anything that reads as a score. So there is **no column anywhere below that holds a
-- Kynviora judgement about a value**. A reference interval is a fact the report printed; a flag
-- is a word the report used. Both are stored as what the source said, both are nullable, and a
-- report that gave neither produces a value with neither - which is the truthful rendering and is
-- what `18` means by an absence being legible.
--
-- The temptation this forecloses is small and specific: a `is_abnormal boolean` computed on write
-- from the interval. It would be one line, it would be right most of the time, and it would make
-- Kynviora the author of a clinical claim about a person it has never examined.
--
-- WHY A NEW CAPABILITY RATHER THAN VIEW_DOCUMENTS
-- `VIEW_DOCUMENTS` exists and is the near miss. It was granted for Visit Packs and capture
-- evidence - the things a caregiver needs to help with a pharmacy visit - and a grant made for
-- that reason must not silently become the right to read somebody's lab history. Same reasoning
-- as DEC-116, and the same consequence: this migration widens the vocabulary and backfills
-- nothing. Every grant keeps exactly the capabilities its owner chose.
--
-- WHY BLOOD PRESSURE IS ONE ROW AND NOT TWO
-- A systolic without its diastolic is not a blood pressure. Stored as two rows they can be
-- separated by a filter, a page boundary or a partial import, and the screen then pairs readings
-- that were never taken together - which is a fabricated measurement produced by a join. So a
-- measurement carries an optional second component, and a CHECK confines it to the metrics that
-- genuinely have one.

-- ---------------------------------------------------------------------------
-- The capability vocabulary, in the two places a CHECK can hold it
-- ---------------------------------------------------------------------------
-- `0002` and `0007` each carry the list because a CHECK cannot reference another table without a
-- subquery, which Postgres forbids. `db/caregiver.test.ts` asserts the two constraints and
-- `CAREGIVER_CAPABILITIES` agree.

ALTER TABLE caregiver_grant
  DROP CONSTRAINT caregiver_grant_capabilities_known;

ALTER TABLE caregiver_grant
  ADD CONSTRAINT caregiver_grant_capabilities_known
    CHECK (capabilities <@ ARRAY[
      'VIEW_SAFETY', 'VIEW_SHELF', 'MANAGE_SHELF', 'VIEW_MEDICINES', 'RECORD_DOSES',
      'MANAGE_MEDICINES', 'VIEW_CARE', 'MANAGE_CARE', 'VIEW_DOCUMENTS', 'EXPORT_SUMMARY',
      'RECEIVE_MISSED_DOSE', 'MANAGE_CAREGIVERS',
      'VIEW_HEALTH_RECORDS', 'MANAGE_HEALTH_RECORDS'
    ]::text[]);

ALTER TABLE caregiver_invitation
  DROP CONSTRAINT caregiver_invitation_capabilities_known;

ALTER TABLE caregiver_invitation
  ADD CONSTRAINT caregiver_invitation_capabilities_known
    CHECK (capabilities <@ ARRAY[
      'VIEW_SAFETY', 'VIEW_SHELF', 'MANAGE_SHELF', 'VIEW_MEDICINES', 'RECORD_DOSES',
      'MANAGE_MEDICINES', 'VIEW_CARE', 'MANAGE_CARE', 'VIEW_DOCUMENTS', 'EXPORT_SUMMARY',
      'RECEIVE_MISSED_DOSE', 'MANAGE_CAREGIVERS',
      'VIEW_HEALTH_RECORDS', 'MANAGE_HEALTH_RECORDS'
    ]::text[]);

-- ---------------------------------------------------------------------------
-- health_source
-- ---------------------------------------------------------------------------
-- Six honest states, and none of them pretends.
--
-- `DESIGNED_NOT_IMPLEMENTED` is the one that earns its place. `21` of the V3 brief asks for
-- future-ready states for Health Connect and HealthKit and then says the thing that makes this a
-- schema concern rather than a copy one: do not visually imply a real integration that has not
-- been implemented. A source row in that state renders as "designed, not implemented" and has no
-- connect button, which is a different screen from an inviting empty state that does nothing.

CREATE TABLE health_source (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id        uuid NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
  -- What kind of origin this is. Not a brand: a brand is `display_name`.
  source_kind       text NOT NULL,
  display_name      text NOT NULL,
  connection_state  text NOT NULL DEFAULT 'NOT_CONNECTED',
  -- When this source last produced anything. NULL means it never has, which is different from
  -- "a long time ago" and is why staleness is not derived from a single nullable timestamp.
  last_received_at  timestamptz,
  -- How long without data before this source is stale, per its own nature. A lab that reports
  -- once a year is not stale in March; a scale with no entry in three weeks is. NULL means
  -- staleness is not a meaningful question for this source.
  stale_after       interval,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CONSTRAINT health_source_kind_valid CHECK (source_kind IN (
    'MANUAL_ENTRY', 'IMPORTED_DOCUMENT', 'PROVIDER_IMPORT',
    'HEALTH_CONNECT', 'HEALTH_KIT', 'WEARABLE', 'HOME_DEVICE')),
  CONSTRAINT health_source_state_valid CHECK (connection_state IN (
    'CONNECTED', 'MANUAL', 'IMPORTED_ONCE', 'STALE', 'NOT_CONNECTED',
    'PERMISSION_REMOVED', 'DESIGNED_NOT_IMPLEMENTED')),
  CONSTRAINT health_source_name_not_blank CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT health_source_stale_after_positive
    CHECK (stale_after IS NULL OR stale_after > interval '0'),
  -- A source that has never received anything cannot be CONNECTED or STALE: both claim a history
  -- of data. This is the constraint that stops an empty integration rendering as a live one.
  CONSTRAINT health_source_state_needs_history CHECK (
    connection_state NOT IN ('STALE', 'IMPORTED_ONCE') OR last_received_at IS NOT NULL)
);

CREATE INDEX health_source_profile_idx ON health_source (profile_id) WHERE deleted_at IS NULL;

CREATE TRIGGER health_source_touch BEFORE UPDATE ON health_source
  FOR EACH ROW EXECUTE FUNCTION kynviora.touch_updated_at();

COMMENT ON COLUMN health_source.connection_state IS
  'The honest state of this origin. A document imported once is not a live connection; a source '
  'with no recent data is stale, not agreeing; DESIGNED_NOT_IMPLEMENTED renders as exactly that '
  'rather than as an empty state that invites a connection nothing would answer.';

-- ---------------------------------------------------------------------------
-- health_record
-- ---------------------------------------------------------------------------
-- A record is not a file. `extraction_state` is the column that keeps that true: it says how the
-- structured observations under this record came to exist, and `NOT_EXTRACTED` is a first-class
-- value meaning the document is on file and nothing was read out of it.
--
-- `04` Phase 1.3: no OCR or inferred fact silently becomes a confirmed record. So an extraction
-- that a person has not checked is `EXTRACTED_UNCONFIRMED`, and the screen says so.

CREATE TABLE health_record (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id         uuid NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
  record_kind        text NOT NULL,
  -- What the record is called. The report's own title where it has one.
  title              text NOT NULL,
  -- Who produced it, as the record states. Free text on purpose: a provider directory is a
  -- different project, and a normalised provider that guessed would be worse than a printed name.
  provider_name      text,
  -- The clinically meaningful date - when the sample was taken, when the visit happened - which
  -- is not when the row was written. A record with no stated date has NULL here rather than
  -- borrowing `created_at`, because "we do not know when this was" is a fact worth keeping.
  recorded_on        date,
  source_id          uuid REFERENCES health_source (id) ON DELETE SET NULL,
  -- The original document, where one was captured. `ON DELETE SET NULL` rather than CASCADE: a
  -- purged image must not take the structured summary with it (`16` purges capture artifacts on
  -- a much shorter clock than records).
  document_asset_id  uuid REFERENCES evidence_asset (id) ON DELETE SET NULL,
  extraction_state   text NOT NULL DEFAULT 'NOT_EXTRACTED',
  provenance         text NOT NULL,
  -- Free-text note the person or importer attached. Never a Kynviora conclusion.
  note               text,
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  CONSTRAINT health_record_kind_valid CHECK (record_kind IN (
    'LAB_REPORT', 'ANNUAL_CHECKUP', 'CLINICAL_LETTER', 'IMAGING_REPORT',
    'VACCINATION', 'PROCEDURE', 'PRESCRIPTION', 'DISCHARGE_SUMMARY', 'OTHER_DOCUMENT')),
  CONSTRAINT health_record_title_not_blank CHECK (length(btrim(title)) > 0),
  CONSTRAINT health_record_extraction_valid CHECK (extraction_state IN (
    'NOT_EXTRACTED', 'EXTRACTION_PENDING', 'EXTRACTED_UNCONFIRMED',
    'EXTRACTED_CONFIRMED', 'EXTRACTION_FAILED', 'ENTERED_BY_HAND')),
  -- Same vocabulary as `allergy_record` (`0004`), and CLINICIAN_CONFIRMED is deliberately absent
  -- from it for the same reason: there is no verified clinician source, so the value would be a
  -- claim nothing could support.
  CONSTRAINT health_record_provenance_valid CHECK (provenance IN (
    'USER_REPORTED', 'CAREGIVER_ENTERED', 'IMPORTED', 'REVIEWER_CONFIRMED')),
  -- An extraction state that claims a document was read requires a document to have read.
  CONSTRAINT health_record_extraction_needs_document CHECK (
    extraction_state IN ('NOT_EXTRACTED', 'ENTERED_BY_HAND') OR document_asset_id IS NOT NULL)
);

CREATE INDEX health_record_profile_idx
  ON health_record (profile_id, recorded_on DESC NULLS LAST) WHERE deleted_at IS NULL;
CREATE INDEX health_record_kind_idx
  ON health_record (profile_id, record_kind) WHERE deleted_at IS NULL;

CREATE TRIGGER health_record_touch BEFORE UPDATE ON health_record
  FOR EACH ROW EXECUTE FUNCTION kynviora.touch_updated_at();

COMMENT ON COLUMN health_record.extraction_state IS
  'How the structured observations under this record came to exist. EXTRACTED_UNCONFIRMED is the '
  'state of anything read from a document that a person has not checked (spec 04 Phase 1.3): no '
  'OCR result silently becomes a confirmed record.';

-- ---------------------------------------------------------------------------
-- health_observation
-- ---------------------------------------------------------------------------
-- One structured result. The columns split into three groups and the split is the whole design:
--
--   what was measured   analyte_code, display_name, sequence
--   what it was         value_numeric or value_text, unit, decimals
--   what the SOURCE     reference_low, reference_high, reference_text, source_flag
--   said about it
--
-- There is no fourth group. Kynviora contributes no opinion about any of these numbers.
--
-- `value_numeric` and `value_text` are both nullable and at least one must be present: a result
-- of 'Not detected' is a real result and is not a missing number. `decimals` records how many
-- places the report printed, so a screen can render 5.2 as 5.2 rather than as 5.20 - a padded
-- value claims precision the lab did not report.

CREATE TABLE health_observation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id       uuid NOT NULL REFERENCES health_record (id) ON DELETE CASCADE,
  -- Denormalised from the record so RLS and retention can be expressed on this table directly.
  -- Kept in step by a CHECK that cannot be written here (a CHECK cannot query), and instead by
  -- the write path plus `db/healthRecords.test.ts`, which asserts every observation's profile
  -- matches its record's.
  profile_id      uuid NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
  -- Stable key for pairing this analyte across two reports. The lab's own code where it gives
  -- one, a normalised slug where it does not. It is what the Change Lens pairs on.
  analyte_code    text NOT NULL,
  display_name    text NOT NULL,
  -- Order within the report, so a comparison can show this year's report in its own order.
  sequence        integer NOT NULL DEFAULT 0,
  value_numeric   numeric,
  value_text      text,
  unit            text,
  decimals        smallint,
  -- The interval the report printed, as the report printed it. Three columns because a report
  -- may give bounds, text ('< 5.0', 'Negative'), or both, and folding text into bounds by
  -- parsing it is where an invented number would come from.
  reference_low   numeric,
  reference_high  numeric,
  reference_text  text,
  -- The word the report used. Not a Kynviora verdict, and the vocabulary is deliberately the
  -- vocabulary of report flags rather than of clinical severity.
  source_flag     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT health_observation_code_not_blank CHECK (length(btrim(analyte_code)) > 0),
  CONSTRAINT health_observation_name_not_blank CHECK (length(btrim(display_name)) > 0),
  -- A result has to be something. Both columns null is a row that says a test was done and
  -- carries no result, which is an absence dressed as a measurement.
  CONSTRAINT health_observation_has_a_value
    CHECK (value_numeric IS NOT NULL OR length(btrim(coalesce(value_text, ''))) > 0),
  CONSTRAINT health_observation_decimals_sane
    CHECK (decimals IS NULL OR (decimals >= 0 AND decimals <= 6)),
  CONSTRAINT health_observation_interval_ordered
    CHECK (reference_low IS NULL OR reference_high IS NULL OR reference_low <= reference_high),
  CONSTRAINT health_observation_flag_valid CHECK (source_flag IS NULL OR source_flag IN (
    'HIGH', 'LOW', 'ABNORMAL', 'CRITICAL', 'BORDERLINE', 'FLAGGED')),
  CONSTRAINT health_observation_sequence_nonnegative CHECK (sequence >= 0),
  UNIQUE (record_id, analyte_code)
);

CREATE INDEX health_observation_record_idx
  ON health_observation (record_id, sequence) WHERE deleted_at IS NULL;
-- The index a trend over one analyte reads, and the one a comparison uses to find the previous
-- comparable result.
CREATE INDEX health_observation_analyte_idx
  ON health_observation (profile_id, analyte_code) WHERE deleted_at IS NULL;

CREATE TRIGGER health_observation_touch BEFORE UPDATE ON health_observation
  FOR EACH ROW EXECUTE FUNCTION kynviora.touch_updated_at();

COMMENT ON COLUMN health_observation.source_flag IS
  'The word the source report used, or NULL. Rendered as "Flagged <word> by source report" and '
  'never as a Kynviora conclusion. There is deliberately no column holding a Kynviora judgement '
  'about a value (spec 09, spec 10).';

COMMENT ON COLUMN health_observation.reference_text IS
  'The interval as the report printed it, where it is not two numbers. Never parsed into '
  'reference_low/high: a bound derived from "< 5.0" is a number the lab did not report.';

-- ---------------------------------------------------------------------------
-- health_measurement
-- ---------------------------------------------------------------------------
-- What Trends is drawn from. One row is one reading at one instant from one source.
--
-- A gap in this table is a gap on the chart. Nothing interpolates, and the schema has no way to
-- express an interpolated point, which is the strongest form that promise can take.

CREATE TABLE health_measurement (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id       uuid NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
  metric           text NOT NULL,
  measured_at      timestamptz NOT NULL,
  value_numeric    numeric NOT NULL,
  -- The second half of a paired reading. Diastolic, where `metric` is BLOOD_PRESSURE.
  value_secondary  numeric,
  unit             text NOT NULL,
  source_id        uuid REFERENCES health_source (id) ON DELETE SET NULL,
  -- The device as it named itself, where a source reported one. Shown in the point detail.
  device_name      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CONSTRAINT health_measurement_metric_valid CHECK (metric IN (
    'HEART_RATE', 'RESTING_HEART_RATE', 'HEART_RATE_VARIABILITY', 'BLOOD_PRESSURE',
    'OXYGEN_SATURATION', 'BODY_TEMPERATURE', 'BODY_WEIGHT', 'BLOOD_GLUCOSE',
    'SLEEP_DURATION', 'STEPS', 'RESPIRATORY_RATE')),
  CONSTRAINT health_measurement_unit_not_blank CHECK (length(btrim(unit)) > 0),
  -- Only a paired metric may carry a second component, and it must carry one. A blood pressure
  -- with a systolic and no diastolic is not a blood pressure, and a weight with two numbers is a
  -- row nobody can render.
  CONSTRAINT health_measurement_pairing CHECK (
    (metric = 'BLOOD_PRESSURE' AND value_secondary IS NOT NULL)
    OR (metric <> 'BLOOD_PRESSURE' AND value_secondary IS NULL)),
  -- Systolic above diastolic. Reversed, it is a transcription error, and a chart drawn from it
  -- shows a bar pointing the wrong way rather than an obviously wrong number.
  CONSTRAINT health_measurement_pair_ordered CHECK (
    value_secondary IS NULL OR value_numeric >= value_secondary),
  UNIQUE (profile_id, metric, measured_at, source_id)
);

CREATE INDEX health_measurement_trend_idx
  ON health_measurement (profile_id, metric, measured_at DESC) WHERE deleted_at IS NULL;

CREATE TRIGGER health_measurement_touch BEFORE UPDATE ON health_measurement
  FOR EACH ROW EXECUTE FUNCTION kynviora.touch_updated_at();

COMMENT ON TABLE health_measurement IS
  'Points in a time series. A gap here is a gap on the chart: there is no column that could hold '
  'an interpolated value, which is the strongest form the promise not to invent one can take.';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- Read needs VIEW_HEALTH_RECORDS, write needs MANAGE_HEALTH_RECORDS. Neither is held by any
-- existing grant, because nothing above backfilled one.
--
-- `health_observation` is scoped by its own `profile_id` rather than through its record. That is
-- a departure from `0004`'s reachability rule and it is deliberate: reachability there means a
-- child is reached only via a parent the policy already admits, which is right when the parent is
-- the unit of access. Here the parent is a *document* and the child is a *result*, and a query
-- for "every TSH this person has" reads the child directly across many parents. A policy that
-- required the join would either be bypassed by that query or force it through a subquery on
-- every row.

-- FORCE as well as ENABLE, because ENABLE alone exempts the table's owner - and the migration
-- role owns every table here. `db/migrations.test.ts` asserts both flags across every table in
-- the schema, which is how this omission was caught rather than shipped.
ALTER TABLE health_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_source FORCE ROW LEVEL SECURITY;
ALTER TABLE health_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_record FORCE ROW LEVEL SECURITY;
ALTER TABLE health_observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_observation FORCE ROW LEVEL SECURITY;
ALTER TABLE health_measurement ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_measurement FORCE ROW LEVEL SECURITY;

CREATE POLICY health_source_select ON health_source
  FOR SELECT TO kynviora_app
  USING (deleted_at IS NULL AND kynviora.has_capability(profile_id, 'VIEW_HEALTH_RECORDS'));
CREATE POLICY health_source_insert ON health_source
  FOR INSERT TO kynviora_app
  WITH CHECK (kynviora.has_capability(profile_id, 'MANAGE_HEALTH_RECORDS'));
CREATE POLICY health_source_update ON health_source
  FOR UPDATE TO kynviora_app
  USING (deleted_at IS NULL AND kynviora.has_capability(profile_id, 'MANAGE_HEALTH_RECORDS'))
  WITH CHECK (kynviora.has_capability(profile_id, 'MANAGE_HEALTH_RECORDS'));
CREATE POLICY health_source_service ON health_source
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

CREATE POLICY health_record_select ON health_record
  FOR SELECT TO kynviora_app
  USING (deleted_at IS NULL AND kynviora.has_capability(profile_id, 'VIEW_HEALTH_RECORDS'));
CREATE POLICY health_record_insert ON health_record
  FOR INSERT TO kynviora_app
  WITH CHECK (kynviora.has_capability(profile_id, 'MANAGE_HEALTH_RECORDS'));
CREATE POLICY health_record_update ON health_record
  FOR UPDATE TO kynviora_app
  USING (deleted_at IS NULL AND kynviora.has_capability(profile_id, 'MANAGE_HEALTH_RECORDS'))
  WITH CHECK (kynviora.has_capability(profile_id, 'MANAGE_HEALTH_RECORDS'));
CREATE POLICY health_record_service ON health_record
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

CREATE POLICY health_observation_select ON health_observation
  FOR SELECT TO kynviora_app
  USING (deleted_at IS NULL AND kynviora.has_capability(profile_id, 'VIEW_HEALTH_RECORDS'));
CREATE POLICY health_observation_insert ON health_observation
  FOR INSERT TO kynviora_app
  WITH CHECK (kynviora.has_capability(profile_id, 'MANAGE_HEALTH_RECORDS'));
CREATE POLICY health_observation_update ON health_observation
  FOR UPDATE TO kynviora_app
  USING (deleted_at IS NULL AND kynviora.has_capability(profile_id, 'MANAGE_HEALTH_RECORDS'))
  WITH CHECK (kynviora.has_capability(profile_id, 'MANAGE_HEALTH_RECORDS'));
CREATE POLICY health_observation_service ON health_observation
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

CREATE POLICY health_measurement_select ON health_measurement
  FOR SELECT TO kynviora_app
  USING (deleted_at IS NULL AND kynviora.has_capability(profile_id, 'VIEW_HEALTH_RECORDS'));
CREATE POLICY health_measurement_insert ON health_measurement
  FOR INSERT TO kynviora_app
  WITH CHECK (kynviora.has_capability(profile_id, 'MANAGE_HEALTH_RECORDS'));
CREATE POLICY health_measurement_update ON health_measurement
  FOR UPDATE TO kynviora_app
  USING (deleted_at IS NULL AND kynviora.has_capability(profile_id, 'MANAGE_HEALTH_RECORDS'))
  WITH CHECK (kynviora.has_capability(profile_id, 'MANAGE_HEALTH_RECORDS'));
CREATE POLICY health_measurement_service ON health_measurement
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

-- No DELETE policy on any of the four, matching every other user-facing table: removal is a soft
-- delete followed by the retention sweep, and the sweep runs as `kynviora_retention`.

GRANT SELECT, INSERT, UPDATE ON health_source, health_record, health_observation,
  health_measurement TO kynviora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON health_source, health_record, health_observation,
  health_measurement TO kynviora_service;

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------
-- `16` promises personal data physically gone within thirty days of deletion, and
-- `docs/RETENTION.md` restates it. Four new tables holding the most sensitive personal data in
-- the product must therefore be sweepable by `kynviora_retention` on the same clock as the rest
-- of the profile, and the DELETE grants and policies here are what makes the PROFILE category in
-- `db/src/retention.ts` able to reach them.
--
-- The policies mirror `0023`: the role sees only rows that are **already** due, so it cannot read
-- a record that is still live even to count it.

GRANT SELECT, DELETE ON health_source, health_record, health_observation, health_measurement
  TO kynviora_retention;

CREATE POLICY health_source_purge ON health_source
  FOR SELECT TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));
CREATE POLICY health_source_purge_delete ON health_source
  FOR DELETE TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));

CREATE POLICY health_record_purge ON health_record
  FOR SELECT TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));
CREATE POLICY health_record_purge_delete ON health_record
  FOR DELETE TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));

CREATE POLICY health_observation_purge ON health_observation
  FOR SELECT TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));
CREATE POLICY health_observation_purge_delete ON health_observation
  FOR DELETE TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));

CREATE POLICY health_measurement_purge ON health_measurement
  FOR SELECT TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));
CREATE POLICY health_measurement_purge_delete ON health_measurement
  FOR DELETE TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));
