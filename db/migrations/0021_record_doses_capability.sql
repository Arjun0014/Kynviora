-- 0021_record_doses_capability.sql
-- Giving "may write into a dose history" a name of its own (`DEV-049`, `BLK-011`, DEC-116).
--
-- Spec references: `07` (the caregiver capability vocabulary; a grant is a specific set of
-- capabilities), `08.2` (a caregiver's capabilities are separately scoped), `11` and `12` (access
-- control is server-authoritative), `18` (a person must be able to understand what they are
-- approving), `04` Phase 4.3.
--
-- WHAT WAS WRONG
-- `0004` scoped every child of `owned_item` by reachability - "child records inherit reachability
-- from their owned item, so there is exactly one place where shelf access is decided" - and `0020`
-- restated it for this table while tightening the one beside it: "`dose_event` is a record of
-- something that happened and is reachability-scoped on purpose, but `review_task` writes need
-- MANAGE_CARE and `allergy` writes need MANAGE_MEDICINES."
--
-- That is a coherent position, and the invitation screen took the opposite one just as
-- deliberately: it groups capabilities into viewing and changing "because that is the distinction
-- a person actually cares about when approving access", and under that grouping `VIEW_MEDICINES`
-- promises no writes at all. Both cannot be true. `services/api/src/doseAuthorization.test.ts`
-- measured the gap against the real policy rather than inferring it: a caregiver granted only
-- `VIEW_MEDICINES` could `POST /v1/dose-events` and write into the owner's dose history.
--
-- The gap is not academic. A dose history is what somebody hands a doctor, and an entry nobody
-- made is a false record of what a person did.
--
-- WHY A THIRD CAPABILITY RATHER THAN EITHER OF THE TWO SIMPLER FIXES
-- Tightening the policy onto `MANAGE_MEDICINES` makes the screen true, and makes the most ordinary
-- act of caring for somebody need the grant that can also delete their medicines and deactivate
-- their reminders. Changing the copy so `VIEW_MEDICINES` admits the write leaves one grant meaning
-- two things, which is what `18` asks the review screen to prevent. `RECORD_DOSES` is the larger
-- change and the only one where each grant says one thing.
--
-- WHY NOTHING IS BACKFILLED
-- This migration widens the vocabulary and touches not one row of `caregiver_grant`. Every grant
-- that exists keeps exactly the capabilities its owner chose, which means an existing view-only
-- caregiver **loses** the dose write they had - the whole point - and no existing grant silently
-- acquires a write nobody approved. A capability appearing in somebody's grant because a migration
-- put it there is the same failure `DEV-049` was, arriving by a different route. An owner who wants
-- a caregiver to keep recording doses grants it, and the grant then says so on the screen.
--
-- Migrating grants forward would also be unsound in a way no data fix could repair: the set of
-- people who would have chosen `RECORD_DOSES` is not derivable from a capability list that never
-- offered it.

-- ---------------------------------------------------------------------------
-- The closed vocabulary, in two places
-- ---------------------------------------------------------------------------
-- `0002` and `0007` each carry the list because a CHECK cannot reference another table without a
-- subquery, which Postgres forbids. `db/caregiver.test.ts` asserts the two constraints and
-- `CAREGIVER_CAPABILITIES` agree, so a list updated in one place and not the others fails the
-- suite rather than allowing an invitation to carry a capability no grant can hold.

ALTER TABLE caregiver_grant
  DROP CONSTRAINT caregiver_grant_capabilities_known;

ALTER TABLE caregiver_grant
  ADD CONSTRAINT caregiver_grant_capabilities_known
    CHECK (capabilities <@ ARRAY[
      'VIEW_SAFETY', 'VIEW_SHELF', 'MANAGE_SHELF', 'VIEW_MEDICINES', 'RECORD_DOSES',
      'MANAGE_MEDICINES', 'VIEW_CARE', 'MANAGE_CARE', 'VIEW_DOCUMENTS', 'EXPORT_SUMMARY',
      'RECEIVE_MISSED_DOSE', 'MANAGE_CAREGIVERS'
    ]::text[]);

ALTER TABLE caregiver_invitation
  DROP CONSTRAINT caregiver_invitation_capabilities_known;

ALTER TABLE caregiver_invitation
  ADD CONSTRAINT caregiver_invitation_capabilities_known
    CHECK (capabilities <@ ARRAY[
      'VIEW_SAFETY', 'VIEW_SHELF', 'MANAGE_SHELF', 'VIEW_MEDICINES', 'RECORD_DOSES',
      'MANAGE_MEDICINES', 'VIEW_CARE', 'MANAGE_CARE', 'VIEW_DOCUMENTS', 'EXPORT_SUMMARY',
      'RECEIVE_MISSED_DOSE', 'MANAGE_CAREGIVERS'
    ]::text[]);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- `0020`'s shape, applied to the table `0020` deliberately left alone.
--
-- WHY SELECT IS UNTOUCHED
-- Reading a dose history needs the medicine to be readable and nothing more, which is what `0004`
-- already says and what `VIEW_MEDICINES` is for. The asymmetry between reading and writing is the
-- point of a capability model, and a caregiver who may look at somebody's medicines may see when
-- they were taken.
--
-- WHY THERE IS NO `item_kind` BRANCH, WHERE `0020` NEEDED ONE
-- `0020` had to name the item kind because the capability governing a personal-care item is
-- `MANAGE_SHELF`, so a policy naming only `MANAGE_MEDICINES` would have checked the wrong
-- capability for a shampoo. There is no second capability here to get wrong: a dose is a
-- medicine's idea, `buildDoseRecord` refuses to build one for a personal-care item on that ground
-- already, and if such a row were ever attempted, requiring `RECORD_DOSES` refuses it - which is
-- the safe direction to be wrong in.
--
-- The owner is unaffected, here as everywhere: `has_capability` short-circuits on `owns_profile`
-- before it looks at a grant at all, so this migration changes nothing for the person whose
-- medicines these are.
--
-- A caller holding `RECORD_DOSES` but not `VIEW_MEDICINES` still cannot write, because the EXISTS
-- subquery reads `owned_item` under its own SELECT policy. That is the same property `0020` left
-- in place and the same safe direction: it refuses a write, it does not admit one.
--
-- There is no UPDATE or DELETE policy to change. `0004` gives `kynviora_app` neither, and
-- `dose_event_append_only` refuses both at the trigger regardless of role - a correction to a dose
-- history is a further event, never a rewrite of the first, so `RECORD_DOSES` covers correcting a
-- record by covering the only way this schema permits one to be corrected.

DROP POLICY dose_event_insert ON dose_event;
CREATE POLICY dose_event_insert ON dose_event
  FOR INSERT TO kynviora_app
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM owned_item i
       WHERE i.id = owned_item_id
         AND kynviora.has_capability(i.profile_id, 'RECORD_DOSES')
    )
  );

COMMENT ON TABLE dose_event IS
  'What happened with a medicine, as the person or their caregiver recorded it (spec 04 Phase '
  '4.3). Append-only. Writing one requires RECORD_DOSES from migration 0021: until then the write '
  'was scoped by reachability, so a grant the invitation screen listed under "viewing" carried a '
  'write into the record a doctor reads (DEV-049).';
