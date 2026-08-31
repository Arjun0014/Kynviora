-- 0011_reconciliation.sql
-- Medicine Reconciliation workflow v1 (spec 04 Phase 8.5).
--
-- Spec references: 04 Phase 8.5, 09 ("Never tell a user to stop/start/split/replace a
-- prescription medicine based solely on Kynviora"), 16 (source attachment, audit without
-- duplicating content), 13 (privileged operations), 07 (provenance).
--
-- THE EXIT CRITERION, AT THE SCHEMA LEVEL
-- "Kynviora never chooses which conflicting instruction is medically correct."
--
-- reconciliation_difference stores previous_value and current_value and has no third column for
-- an answer. There is nowhere to record a system-chosen winner, so no code path - including a
-- direct SQL statement - can produce one. The resolution vocabulary is a closed list in which
-- every settled member names a person or a document, and a CHECK requires the two self-describing
-- members to agree with the side actually adopted.

CREATE TABLE reconciliation (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id          uuid NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
  started_by_user_id  uuid NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  state               text NOT NULL DEFAULT 'OPEN',
  -- What prompted it. Descriptive only; nothing branches on it.
  source_kind         text NOT NULL DEFAULT 'OTHER',
  -- 04 Phase 8.5 "source attachment": the discharge summary or printed list the current side
  -- came from, so a later reader can see what was being compared against.
  source_evidence_asset_id uuid REFERENCES evidence_asset (id) ON DELETE SET NULL,
  source_note         text,
  started_at          timestamptz NOT NULL,
  completed_at        timestamptz,
  -- Recorded at completion. 04 Phase 8.5 lists unresolved differences as expected output, so a
  -- reconciliation that ends with open questions is a normal outcome, not a failure.
  unresolved_count    integer,
  client_operation_id uuid,

  CONSTRAINT reconciliation_state_valid CHECK (state IN ('OPEN', 'COMPLETED', 'ABANDONED')),
  CONSTRAINT reconciliation_source_kind_valid
    CHECK (source_kind IN ('VISIT', 'DISCHARGE', 'PHARMACY', 'OTHER')),
  CONSTRAINT reconciliation_completed_complete
    CHECK (state <> 'COMPLETED' OR (completed_at IS NOT NULL AND unresolved_count IS NOT NULL)),
  CONSTRAINT reconciliation_open_is_unfinished
    CHECK (state <> 'OPEN' OR (completed_at IS NULL AND unresolved_count IS NULL))
);

CREATE INDEX reconciliation_profile_idx ON reconciliation (profile_id, started_at DESC);
CREATE UNIQUE INDEX reconciliation_operation_idx
  ON reconciliation (client_operation_id) WHERE client_operation_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- reconciliation_difference
-- ---------------------------------------------------------------------------

CREATE TABLE reconciliation_difference (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id   uuid NOT NULL REFERENCES reconciliation (id) ON DELETE CASCADE,
  difference_kind     text NOT NULL,
  -- The key the two lists were matched on. Supplied by the caller; never inferred here, because
  -- deciding two differently-named lines are the same medicine is a catalog judgement.
  match_key           text NOT NULL,
  display_name        text NOT NULL,
  -- Present when the previous side came from the shelf.
  owned_item_id       uuid REFERENCES owned_item (id) ON DELETE SET NULL,

  -- Which field disagrees, and both values. There is deliberately no third column.
  field_path          text,
  previous_value      text,
  current_value       text,

  resolution          text,
  -- Which value the person said now stands. Never inferred: a pharmacist may confirm the older
  -- dose, and defaulting to the newer list would be Kynviora deciding which is correct.
  adopted_side        text,
  -- Who confirmed it, when a professional did. Free text entered by the user.
  confirmed_by        text,
  resolution_note     text,
  resolved_at         timestamptz,
  resolved_by_user_id uuid REFERENCES app_user (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT difference_kind_valid
    CHECK (difference_kind IN ('ONLY_IN_PREVIOUS', 'ONLY_IN_CURRENT', 'FIELD_DIFFERS', 'MATCHES')),

  -- The closed resolution vocabulary. Every settled member names a person or a document; there is
  -- no AUTO_RESOLVED, SYSTEM_CHOSE or RECOMMENDED, so "the app decided" is not writable.
  CONSTRAINT difference_resolution_valid
    CHECK (resolution IS NULL OR resolution IN (
      'CONFIRMED_WITH_PRESCRIBER', 'CONFIRMED_WITH_PHARMACIST', 'CONFIRMED_FROM_DOCUMENT',
      'USER_KEPT_PREVIOUS', 'USER_ADOPTED_CURRENT', 'STILL_UNRESOLVED')),

  CONSTRAINT difference_adopted_side_valid
    CHECK (adopted_side IS NULL OR adopted_side IN ('PREVIOUS', 'CURRENT')),

  -- A professional confirmation must name the professional. "Confirmed with pharmacist" with
  -- nobody named is indistinguishable from a shrug, and the name is what a later reader uses to
  -- weigh the record.
  CONSTRAINT difference_confirmation_names_someone
    CHECK (
      resolution IS NULL
      OR resolution NOT IN ('CONFIRMED_WITH_PRESCRIBER', 'CONFIRMED_WITH_PHARMACIST')
      OR (confirmed_by IS NOT NULL AND length(btrim(confirmed_by)) > 0)
    ),

  -- The two self-describing resolutions must agree with the side adopted, or the record would
  -- read "the user kept the previous value" while holding the current one.
  CONSTRAINT difference_resolution_matches_side
    CHECK (
      resolution IS NULL
      OR (resolution = 'USER_KEPT_PREVIOUS' AND adopted_side = 'PREVIOUS')
      OR (resolution = 'USER_ADOPTED_CURRENT' AND adopted_side = 'CURRENT')
      OR (resolution = 'STILL_UNRESOLVED' AND adopted_side IS NULL)
      OR resolution IN ('CONFIRMED_WITH_PRESCRIBER', 'CONFIRMED_WITH_PHARMACIST',
                        'CONFIRMED_FROM_DOCUMENT')
    ),

  -- A settled difference names a side. An unresolved one names neither: letting it carry a side
  -- would put a decision into the record that nobody made.
  CONSTRAINT difference_settled_has_side
    CHECK (
      resolution IS NULL
      OR (resolution = 'STILL_UNRESOLVED' AND adopted_side IS NULL)
      OR (resolution <> 'STILL_UNRESOLVED' AND adopted_side IS NOT NULL)
    ),

  CONSTRAINT difference_resolved_is_attributed
    CHECK (
      resolution IS NULL
      OR (resolved_at IS NOT NULL AND resolved_by_user_id IS NOT NULL)
    ),

  -- A MATCHES row has nothing to settle. Allowing a resolution on one would let a reconciliation
  -- record a decision about a medicine nobody disagreed about.
  CONSTRAINT difference_matches_is_not_resolvable
    CHECK (difference_kind <> 'MATCHES' OR resolution IS NULL),

  -- Only a FIELD_DIFFERS row names a field and carries two values.
  CONSTRAINT difference_fields_match_kind
    CHECK (
      (difference_kind = 'FIELD_DIFFERS' AND field_path IS NOT NULL)
      OR (difference_kind <> 'FIELD_DIFFERS' AND field_path IS NULL
          AND previous_value IS NULL AND current_value IS NULL)
    )
);

CREATE INDEX difference_reconciliation_idx
  ON reconciliation_difference (reconciliation_id, created_at);

COMMENT ON TABLE reconciliation_difference IS
  'A disagreement between two medication lists. Stores both values and no third column for an '
  'answer: 04 Phase 8.5 requires that Kynviora never choose which instruction is correct.';

COMMENT ON COLUMN reconciliation_difference.adopted_side IS
  'Which value the person said now stands. Never inferred - a professional may confirm the older '
  'value, and defaulting to the newer list would be the software deciding.';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

ALTER TABLE reconciliation ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation FORCE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_difference ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_difference FORCE ROW LEVEL SECURITY;

-- A reconciliation is about medicines, so it takes the medicines capabilities and not the shelf
-- ones. 03 group H keeps those separate, and a reconciliation shows every direction line the
-- household holds - it is among the most revealing screens in the product.
GRANT SELECT ON reconciliation, reconciliation_difference TO kynviora_app;
GRANT SELECT, INSERT, UPDATE ON reconciliation, reconciliation_difference TO kynviora_service;

CREATE POLICY reconciliation_read ON reconciliation
  FOR SELECT TO kynviora_app
  USING (kynviora.has_capability(profile_id, 'VIEW_MEDICINES'));

CREATE POLICY reconciliation_service ON reconciliation
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

CREATE POLICY difference_read ON reconciliation_difference
  FOR SELECT TO kynviora_app
  USING (EXISTS (
    SELECT 1 FROM reconciliation r
     WHERE r.id = reconciliation_id
       AND kynviora.has_capability(r.profile_id, 'VIEW_MEDICINES')
  ));

CREATE POLICY difference_service ON reconciliation_difference
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);
