-- 0019_health_fact_substance_mapping.sql
-- Why a recorded term is or is not something a rule can see (spec 04 Phase 5.2, spec 08).
--
-- Spec references: 04 Phase 5.2 ("canonical ingredient/substance normalization"; "a human review
-- queue for material unresolved mappings"), 04 Phase 1.3, 08 ("crowd observations never create or
-- modify a canonical substance"), 15 A11, 10 (state the limits where you state the findings),
-- DEC-093.
--
-- WHAT WAS MISSING
-- allergy_record.substance_id has been nullable since 0004 and nothing has ever set it, so every
-- hand-entered allergy in this build is unmapped and therefore invisible to the one rule that
-- would use it - evaluateIngredientSensitivity filters to facts with a canonical key. The
-- normalization engine that would map it has existed since Stage 5 and was only ever pointed at
-- ingredient declarations, never at what a person typed about themselves.
--
-- WHY A STATE AND NOT JUST THE ID
-- A NULL substance_id answers "can a rule see this" and not "why not", and the two reasons are
-- different things to be told. "Kynviora does not know that word" is a gap in a licensed
-- vocabulary (BLK-003) and nothing the person can do about it. "That word means more than one
-- thing here" is something they can fix by being more specific - and it is also the queue spec 04
-- Phase 5.2 asks for, which cannot exist while the two are the same NULL.
--
-- Deriving the state on the read path by resolving the term again would be the mistake DEV-028
-- has just been closed for: the vocabulary may have moved since, so a re-resolution can disagree
-- with the mapping that is actually stored on the row and drives the rule.
--
-- WHAT THIS DOES NOT DO
-- No user text ever creates or modifies a canonical substance or an alias. Resolution is a read
-- against the seeded vocabulary, and an unrecognised term stays unrecognised - spec 08 and threat
-- A11, the same rule manual entry keeps for products.

ALTER TABLE allergy_record
  ADD COLUMN substance_mapping_state text NOT NULL DEFAULT 'UNRESOLVED';

ALTER TABLE allergy_record
  ADD CONSTRAINT allergy_mapping_state_valid
    CHECK (substance_mapping_state IN ('EXACT', 'AMBIGUOUS', 'UNRESOLVED'));

-- The state and the mapping cannot disagree. EXACT with no substance would claim a rule can see a
-- record it cannot; a substance under any other state would let one drive a rule on a mapping
-- nobody resolved. Both directions matter, so this is a biconditional rather than two implications
-- - and every row written before this migration satisfies it, because nothing ever set
-- substance_id.
ALTER TABLE allergy_record
  ADD CONSTRAINT allergy_mapping_state_agrees_with_substance
    CHECK ((substance_id IS NOT NULL) = (substance_mapping_state = 'EXACT'));

COMMENT ON COLUMN allergy_record.substance_mapping_state IS
  'Why this term is or is not mapped to a canonical substance (spec 04 Phase 5.2). EXACT means '
  'substance_id is set and a rule matching on canonical substances can see this record. AMBIGUOUS '
  'means the term resolved to more than one substance and was deliberately not resolved to any. '
  'UNRESOLVED means the seeded vocabulary does not carry the term, which is the default and the '
  'state of every row written before this migration.';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- Nothing to add. This is a column on a table whose 0004 policies already decide who may read and
-- write it: allergy_select requires VIEW_MEDICINES and allergy_insert/allergy_update require
-- MANAGE_MEDICINES. The value is derived by the server from the term the caller supplied, and no
-- client may set it - the routes take no parameter for it, for the same reason no body carries a
-- provenance (DEC-091).
