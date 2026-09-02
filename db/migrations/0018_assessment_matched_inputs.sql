-- 0018_assessment_matched_inputs.sql
-- Which ingredient matched which recorded sensitivity (`DEV-028`, spec 04 Phase 7.3, spec 09).
--
-- Spec references: 04 Phase 7.3 ("independently understandable"; the approved ingredient
-- sensitivity template names the exact ingredient and the exact recorded sensitivity), 09 ("store
-- exact references to profile facts"; "replaying the same versions must reproduce the result"),
-- 10, 17, DEC-064.
--
-- WHAT WAS MISSING
-- `profile_assessment` has stored `reasons` (machine codes), `profile_fact_versions` and
-- `formulation_version` since 0006 - versions and codes, but not identities. So the alert detail
-- could say *that* a substance in the declaration matched a recorded fact and could not say
-- *which*, and `explanationFor` refused to render `tpl.ingredient_sensitivity` rather than name a
-- substance it was guessing at. The alert was readable and less useful than the spec intends.
--
-- WHY NOT DERIVE IT ON THE READ PATH
-- The obvious alternative - join the item's formulation to the profile's allergy records and take
-- the intersection - is a *different computation* from the one the rule ran. The declaration and
-- the facts may both have moved since, so it could name a substance the rule did not match on: a
-- confident, specific, approved-looking sentence about the wrong ingredient, which is worse than
-- no sentence. DEC-064 decided exactly this for the Lens. So the identity is frozen at evaluation
-- time beside the versions that were already frozen there.
--
-- WHY NO FOREIGN KEY ON THE FACT ID
-- Two reasons, and the first is mechanical. `profile_assessment` carries a BEFORE UPDATE OR DELETE
-- trigger that raises unconditionally (DEC-013), so a referential action cannot fire: ON DELETE
-- SET NULL would attempt an UPDATE and ON DELETE CASCADE a DELETE, and both would trip the trigger
-- and fail the parent delete instead of tidying anything. ON DELETE RESTRICT would work and would
-- make an allergy record undeletable forever, which is a retention decision this build has not
-- made (`DEV-036`).
--
-- The second reason is the point of the column. This is a record of what the rule *saw*, and a
-- reference that could be nulled or cascaded is one a later event can quietly rewrite - which is
-- the retroactive change the append-only trigger exists to prevent. A dangling ID resolves to no
-- name and the template declines to render, which is the same honest outcome as never having had
-- one.

ALTER TABLE profile_assessment
  -- The canonical substance key the rule matched on. Text rather than a reference to
  -- normalized_substance for the reason above, and because the key is the stable identity across
  -- vocabulary versions while the row's id is not.
  ADD COLUMN matched_substance_key text,
  -- allergy_record.id of the fact that matched. Not a foreign key; see above.
  ADD COLUMN matched_profile_fact_id uuid;

-- Both or neither. A key with no fact names an ingredient and cannot say whose sensitivity it
-- matched; a fact with no key is the half the template cannot use. Either alone would render as a
-- sentence with a hole in it, and the template's own refusal is the better outcome.
ALTER TABLE profile_assessment
  ADD CONSTRAINT assessment_matched_inputs_paired
    CHECK ((matched_substance_key IS NULL) = (matched_profile_fact_id IS NULL));

-- A non-match matched nothing, so it can name nothing. Without this a row could carry
-- `matched = false` and still say which ingredient was involved, which is a sentence about a
-- match that did not happen.
ALTER TABLE profile_assessment
  ADD CONSTRAINT assessment_matched_inputs_only_when_matched
    CHECK (matched OR matched_substance_key IS NULL);

ALTER TABLE profile_assessment
  ADD CONSTRAINT assessment_matched_substance_not_blank
    CHECK (matched_substance_key IS NULL OR length(btrim(matched_substance_key)) > 0);

-- Not indexed. Nothing looks an assessment up *by* the ingredient it matched, and an index on a
-- health-adjacent column invites the query that would - "who in this household reacts to X" is a
-- question the safety inbox does not ask and this table should not make cheap.

COMMENT ON COLUMN profile_assessment.matched_substance_key IS
  'Canonical substance key the rule matched on, frozen at evaluation (DEV-028, spec 09). NULL on '
  'every row written before 0018 and on every non-match. Deriving it on the read path would be a '
  'different computation from the one the rule ran (DEC-064).';

COMMENT ON COLUMN profile_assessment.matched_profile_fact_id IS
  'allergy_record.id the rule matched on, frozen at evaluation (DEV-028). Deliberately not a '
  'foreign key: profile_assessment is append-only, so no referential action could fire without '
  'tripping its trigger, and a reference a later delete could rewrite is not a frozen record.';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- Nothing to add. These are two columns on a table whose 0006 policies already decide who may read
-- it: `assessment_read` admits a caller who can reach the profile, and only kynviora_service may
-- insert. What they add to what a reader can already see is the identity of a fact that reader
-- could already read directly on the same profile - so this widens no disclosure, and the alert
-- detail's own withholding rules (`15` A6) still decide whether the sentence is rendered.
