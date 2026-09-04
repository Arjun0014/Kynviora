-- 0022_retention.sql
-- Making deletion a thing this schema can do, and making the two tables that outlive a deletion
-- survive it (DEC-117, `DEV-036`, `DEV-056`).
--
-- Spec references: `16` (retention matrix, deletion enumeration, export expiry), `14` (least
-- privilege, append-only audit), `13` (server-authoritative authorization), `07`.
--
-- WHAT THIS MIGRATION IS FOR
-- `docs/RETENTION.md` states the approved policy. Deletion is two events with different
-- guarantees: **revocation** is synchronous and total - the record becomes inaccessible and all
-- processing stops in the request that accepts the deletion - and **purge** is asynchronous with a
-- deadline. This migration builds the second half of that and closes three places where the schema
-- contradicted the first.
--
-- Nothing here deletes anything. It gives the database the shape a purge needs and the role a
-- purge must run as; the purge itself is a server operation.

-- ---------------------------------------------------------------------------
-- 1. The retention role
-- ---------------------------------------------------------------------------
-- `audit_event` and `consent_receipt` are append-only by trigger (DEC-013) and grant DELETE to
-- nobody. That is the invariant that makes them worth having: a record of who did what, which the
-- person who did it cannot remove. A 24-month retention limit needs a way through it, and the way
-- through is a third role rather than a widened grant on either existing one.
--
-- `kynviora_retention` is NOLOGIN, is a member of neither other role, and holds no grant on any
-- other table. It cannot read a medicine, write an audit event, or delete a row that is not old
-- enough. The only thing it can do is the one thing it exists for.
--
-- Widening `kynviora_service` instead would have been two lines shorter and would have given every
-- server operation - ingestion, publication, grant finalisation, the seed - the standing ability to
-- delete audit history. `14` asks for least privilege, and the privilege being minimised here is
-- specifically the one an attacker who reaches the service role would use to cover their tracks.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kynviora_retention') THEN
    CREATE ROLE kynviora_retention NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA kynviora TO kynviora_retention;
GRANT USAGE ON SCHEMA public TO kynviora_retention;

-- ---------------------------------------------------------------------------
-- 2. The age gate
-- ---------------------------------------------------------------------------
-- 24 months, from the row's own timestamp. One definition, called by both the RLS policy and the
-- trigger, so the two gates cannot drift apart into a window where one admits and the other
-- refuses.

CREATE OR REPLACE FUNCTION kynviora.retention_floor() RETURNS timestamptz
LANGUAGE sql STABLE
AS $$
  SELECT now() - interval '24 months';
$$;

COMMENT ON FUNCTION kynviora.retention_floor() IS
  'The oldest timestamp a retained append-only row may have and still be protected. Rows at or '
  'before this are purgeable by kynviora_retention and by nothing else (DEC-117).';

GRANT EXECUTE ON FUNCTION kynviora.retention_floor() TO
  kynviora_app, kynviora_service, kynviora_retention;

-- ---------------------------------------------------------------------------
-- 3. Append-only, with exactly one door
-- ---------------------------------------------------------------------------
-- `forbid_mutation` refuses every UPDATE and DELETE on the tables that carry it. It is replaced
-- here rather than dropped from the two retained tables, because dropping it would make the door
-- the size of the table.
--
-- The replacement refuses everything it refused before, and additionally admits exactly one case:
-- a DELETE, by `kynviora_retention`, of a row past the age gate, on a table that has opted in by
-- passing its timestamp column as a trigger argument. A table with no argument gets the old
-- behaviour unchanged, which is every other table carrying this trigger - `dose_event`,
-- `field_assertion`, and the published safety records.
--
-- WHY THE TRIGGER AND THE POLICY BOTH, AND WHAT EACH ONE ACTUALLY GUARANTEES
-- They guard different things, and saying which is which matters more than saying "defence in
-- depth".
--
-- **RLS decides the role.** Only `kynviora_retention` has a DELETE policy here at all, so the
-- app and service roles are refused by a missing grant before any policy is consulted.
--
-- **The trigger decides the age.** Its condition is `pg_has_role(..., MEMBER)`, and a superuser
-- is a member of every role - so the door is open to one. That is not a weakening, because a
-- superuser can drop the trigger outright; it is the reason the trigger is not claimed as a
-- role gate. What it guarantees is narrower and holds against everybody including a superuser:
-- **nothing younger than the floor passes**, whoever asks. An in-window DELETE raises even where
-- RLS is bypassed entirely, which is the case DEC-005 says a superuser and, under some
-- configurations, the table owner reach.
--
-- The two together mean a migration that dropped the policy would still be stopped from deleting
-- recent history, and one that dropped the trigger would still be stopped from deleting anything
-- as an ordinary role. Dropping both is a deliberate act, and reads as one.
--
-- Retention deletes whole rows past an age; it does not edit history, and a correction supersedes
-- as it always has. The one UPDATE the trigger admits is a **de-link** - the declared subject
-- columns cleared and nothing else changed - which is what an `ON DELETE SET NULL` foreign key
-- performs at purge and is described at door two below. It cannot alter a single field of the
-- record it is severing.

CREATE OR REPLACE FUNCTION kynviora.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ts_column   text;
  row_ts      timestamptz;
  delinkable  text[];
  column_name text;
  is_delink   boolean;
  old_rest    jsonb;
  new_rest    jsonb;
BEGIN
  -- Door one: retention. Everything about it is conjunctive and each conjunct is load-bearing.
  IF TG_OP = 'DELETE'
     AND TG_NARGS >= 1
     AND pg_has_role(current_user, 'kynviora_retention', 'MEMBER')
  THEN
    ts_column := TG_ARGV[0];
    EXECUTE format('SELECT ($1).%I', ts_column) INTO row_ts USING OLD;

    IF row_ts IS NOT NULL AND row_ts <= kynviora.retention_floor() THEN
      RETURN OLD;
    END IF;

    RAISE EXCEPTION
      'Row in % is within the retention period and cannot be purged yet (see DEC-117).',
      TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Door two: de-linking. An UPDATE that clears the declared subject columns and changes nothing
  -- else at all. This is what an `ON DELETE SET NULL` foreign key performs when the subject is
  -- purged, and without it the purge fails on the very row it is meant to preserve - keeping the
  -- receipt whole, linkage included, which is worse than either intended outcome.
  --
  -- It is recognised by **shape**, and the shape is the whole guarantee: every declared column
  -- ends NULL, and stripping those columns from both versions of the row leaves two identical
  -- rows. Nothing can move under cover of a de-link, and a declared column cannot be re-pointed
  -- at a different subject - that is a rewrite, and it falls through to the blanket refusal along
  -- with every other edit.
  --
  -- Recognising it by shape rather than checking columns one at a time is also what keeps the
  -- error messages honest. An ordinary edit here has nothing to do with linkage, and is told what
  -- it has always been told: this table is append-only, supersede instead.
  IF TG_OP = 'UPDATE' AND TG_NARGS > 1 THEN
    delinkable := TG_ARGV[1:];
    old_rest := to_jsonb(OLD);
    new_rest := to_jsonb(NEW);
    is_delink := true;

    FOREACH column_name IN ARRAY delinkable LOOP
      IF new_rest -> column_name <> 'null'::jsonb THEN
        is_delink := false;
      END IF;
      old_rest := old_rest - column_name;
      new_rest := new_rest - column_name;
    END LOOP;

    IF is_delink AND old_rest = new_rest THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION
    'Table % is append-only; use supersession instead of % (see DEC-013).',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

-- Re-create the two triggers with their doors named. Every other table's trigger is untouched and
-- keeps the no-argument form, so nothing else acquires either door.
--
-- `audit_event` gets the retention door and **no de-link door**. Its `actor_user_id` is a bare
-- uuid with no foreign key, so nothing fires one; and an audit event whose actor has been erased
-- answers none of the questions `14` keeps it for. The record it points at is gone, which is what
-- stops the identifier being a way back into it.

DROP TRIGGER audit_event_append_only ON audit_event;
CREATE TRIGGER audit_event_append_only
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION kynviora.forbid_mutation('occurred_at');

DROP TRIGGER consent_receipt_append_only ON consent_receipt;
CREATE TRIGGER consent_receipt_append_only
  BEFORE UPDATE OR DELETE ON consent_receipt
  FOR EACH ROW EXECUTE FUNCTION kynviora.forbid_mutation('recorded_at', 'user_id', 'profile_id');

-- ---------------------------------------------------------------------------
-- 4. The retention grants and policies
-- ---------------------------------------------------------------------------
-- SELECT as well as DELETE: a sweep has to find the rows before it can remove them, and a role
-- that could delete what it could not read would be one nobody could test. It reads only these
-- two tables, and both hold identifiers and versions rather than health content (`20`).

GRANT SELECT, DELETE ON audit_event TO kynviora_retention;
GRANT SELECT, DELETE ON consent_receipt TO kynviora_retention;

CREATE POLICY audit_retention_select ON audit_event
  FOR SELECT TO kynviora_retention
  USING (occurred_at <= kynviora.retention_floor());

CREATE POLICY audit_retention_delete ON audit_event
  FOR DELETE TO kynviora_retention
  USING (occurred_at <= kynviora.retention_floor());

CREATE POLICY consent_retention_select ON consent_receipt
  FOR SELECT TO kynviora_retention
  USING (recorded_at <= kynviora.retention_floor());

CREATE POLICY consent_retention_delete ON consent_receipt
  FOR DELETE TO kynviora_retention
  USING (recorded_at <= kynviora.retention_floor());

-- ---------------------------------------------------------------------------
-- 5. `DEV-056` (1) - a consent receipt that dies with its subject
-- ---------------------------------------------------------------------------
-- `consent_receipt` carried `user_id -> app_user ON DELETE CASCADE` and
-- `profile_id -> profile ON DELETE CASCADE`. The approved policy keeps consent receipts for 24
-- months **after** deletion, so as written the receipt proving somebody withdrew consent is
-- destroyed by the purge that withdrawing it led to - silently, by a foreign key, at the moment it
-- is most likely to be asked for.
--
-- Both references are de-linked instead. The receipt keeps its purpose, its decision, its policy
-- version and its timestamp, which is the whole of what it is retained for; what it loses is the
-- pointer to a subject that no longer exists. `user_id` becomes nullable for the same reason, and
-- the purge nulls it rather than the database cascading it.
--
-- WHY THE RECEIPT IS STILL WORTH KEEPING ONCE DE-LINKED
-- Because the question it answers is "was consent for this purpose in force under this policy
-- version at this time", and that question survives the subject. A receipt that named a purged
-- person would be the retained table becoming a back door into the record it refers to, which
-- `docs/RETENTION.md` section 3.3 rules out.

ALTER TABLE consent_receipt DROP CONSTRAINT consent_receipt_user_id_fkey;
ALTER TABLE consent_receipt ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE consent_receipt
  ADD CONSTRAINT consent_receipt_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES app_user (id) ON DELETE SET NULL;

ALTER TABLE consent_receipt DROP CONSTRAINT consent_receipt_profile_id_fkey;
ALTER TABLE consent_receipt
  ADD CONSTRAINT consent_receipt_profile_id_fkey
    FOREIGN KEY (profile_id) REFERENCES profile (id) ON DELETE SET NULL;

-- The read policy compared `user_id` to the caller. A NULL there must not become "everybody's
-- receipt": NULL = anything is NULL, which is already false, but stating it makes the intent
-- survive a future edit of the policy.

DROP POLICY consent_select ON consent_receipt;
CREATE POLICY consent_select ON consent_receipt
  FOR SELECT TO kynviora_app
  USING (user_id IS NOT NULL AND user_id = kynviora.current_user_id());

-- ---------------------------------------------------------------------------
-- 6. `DEV-056` (2) - a household item id that outlives the item
-- ---------------------------------------------------------------------------
-- `shadow_run_sample.owned_item_id` is a bare uuid with no foreign key, in a staff-readable table.
-- The missing key is deliberate - a shadow run over a dataset must not pin the dataset - and its
-- cost is a linkage that survives the item's purge indefinitely. Nothing dereferences it once the
-- item is gone, which is what makes it a linkage rather than a leak of content, and
-- `docs/RETENTION.md` section 3.4 says a linkage is purged.
--
-- Nullable, so the purge can de-link it. The sample's own content - matched, confidence, reasons,
-- evidence level, urgency - is a measurement of a rule and is not personal, so it survives.

ALTER TABLE shadow_run_sample ALTER COLUMN owned_item_id DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 7. `DEV-056` (3) - a correction that blocks the purge it should yield to
-- ---------------------------------------------------------------------------
-- Both of `assessment_correction`'s references were `ON DELETE RESTRICT`, so a corrected
-- assessment could not be purged at all while the correction stood. `RESTRICT` is right when the
-- referenced row is evidence the referring row depends on; it is wrong when the referring row is
-- staff-operational data and the referenced row is somebody's health record with a deletion
-- deadline. The health record wins.

ALTER TABLE assessment_correction DROP CONSTRAINT assessment_correction_original_assessment_id_fkey;
ALTER TABLE assessment_correction ALTER COLUMN original_assessment_id DROP NOT NULL;
ALTER TABLE assessment_correction
  ADD CONSTRAINT assessment_correction_original_assessment_id_fkey
    FOREIGN KEY (original_assessment_id) REFERENCES profile_assessment (id) ON DELETE SET NULL;

ALTER TABLE assessment_correction DROP CONSTRAINT assessment_correction_corrected_assessment_id_fkey;
ALTER TABLE assessment_correction
  ADD CONSTRAINT assessment_correction_corrected_assessment_id_fkey
    FOREIGN KEY (corrected_assessment_id) REFERENCES profile_assessment (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 8. Deleting an owned item
-- ---------------------------------------------------------------------------
-- `owned_item.deleted_at` has existed since `0004` and nothing has ever written it: every SELECT
-- policy filters on it, so the revocation half of a deletion has been built and unreachable the
-- whole time. `DEV-032` is the absence of the thing that sets it.
--
-- WHY THE APP ROLE CANNOT WRITE IT, AND WHY THAT IS NOT A CHOICE MADE HERE (`DEV-057`)
-- An UPDATE whose WHERE clause reads a column of the table requires SELECT rights on it, and
-- Postgres applies the SELECT policies **to the new row as well as the old**. `owned_item_select`
-- filters `deleted_at IS NULL`, so the row a soft delete produces is one the caller may not see,
-- and the statement fails with "new row violates row-level security policy" - for the **owner**,
-- not only for a caregiver. This was measured rather than assumed: with the SELECT policy's
-- `deleted_at` filter removed and nothing else changed, the same statement succeeds.
--
-- So there is no RLS policy that makes a soft delete work from the app role while the deletion
-- stays a deletion. The choice is between a row a person can still read and a write that goes
-- somewhere else.
--
-- WHERE IT GOES INSTEAD
-- Through the service role, which `13` already names for "deletion orchestration" and whose
-- `owned_item_service` policy admits the new row. This is the pattern `safety_receipt` and
-- `notification_revalidation` already use: the route establishes authority by reading under
-- row-level security first - a caller who cannot see the item cannot delete it - and the
-- privileged write then carries the same predicate again, so it cannot be wider than the check
-- that authorised it.
--
-- The predicate is held here rather than in the route, in one function, so "only an owner may
-- delete" is a thing the database says. `profile_owned_by` is `owns_profile`'s body with the user
-- supplied instead of read from the request GUC, and `owns_profile` now calls it - one
-- definition, two callers, so the rule cannot drift between the policy and the purge.

CREATE OR REPLACE FUNCTION kynviora.profile_owned_by(
  target_profile_id uuid,
  candidate_user_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT candidate_user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM profile p
     WHERE p.id = target_profile_id
       AND p.deleted_at IS NULL
       AND p.owner_user_id = candidate_user_id
  );
$$;

-- Unchanged in meaning: the request GUC, passed to the definition above. An unset GUC is NULL,
-- which the explicit guard now refuses rather than leaving it to NULL comparison to fail closed.
CREATE OR REPLACE FUNCTION kynviora.owns_profile(target_profile_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT kynviora.profile_owned_by(target_profile_id, kynviora.current_user_id());
$$;

REVOKE ALL ON FUNCTION kynviora.profile_owned_by(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kynviora.profile_owned_by(uuid, uuid)
  TO kynviora_app, kynviora_service;

-- The stamp. Returns whether a row was stamped, so a caller can tell "deleted" from "already
-- deleted, or not yours" without this function being an oracle for which - `13` does not let the
-- API distinguish those, and a function returning three answers would tempt a route to.
--
-- `deleted_at IS NULL` in the WHERE is what makes a second delete a no-op rather than a second
-- stamp: the purge deadline is measured from it, and an item that could be re-stamped could be
-- kept past its deadline by deleting it repeatedly.

CREATE OR REPLACE FUNCTION kynviora.delete_owned_item(
  target_item_id uuid,
  acting_user_id uuid
) RETURNS boolean
LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
  stamped boolean;
BEGIN
  UPDATE owned_item
     SET deleted_at = now()
   WHERE id = target_item_id
     AND deleted_at IS NULL
     AND kynviora.profile_owned_by(profile_id, acting_user_id)
  RETURNING true INTO stamped;
  RETURN coalesce(stamped, false);
END
$$;

REVOKE ALL ON FUNCTION kynviora.delete_owned_item(uuid, uuid) FROM PUBLIC;
-- The service role only. The app role has no path to this function and no path to `deleted_at`.
GRANT EXECUTE ON FUNCTION kynviora.delete_owned_item(uuid, uuid) TO kynviora_service;

-- ---------------------------------------------------------------------------
-- 8b. The rule stated, so it survives the accident that currently enforces it
-- ---------------------------------------------------------------------------
-- `0004` grants UPDATE on `owned_item` to `kynviora_app` **table-wide**, and `owned_item_update`
-- admits `MANAGE_MEDICINES` on a medicine and `MANAGE_SHELF` on a personal-care product. Today a
-- caregiver still cannot set `deleted_at`, for the reason in section 8 - but that reason is a
-- **side effect of the SELECT policy**, not a rule anybody wrote down.
--
-- The likeliest future that removes it is an ordinary product one: a "recently deleted" list, or
-- an undo, either of which needs an owner to see a row after deleting it. Relax
-- `owned_item_select` for that and `MANAGE_MEDICINES` silently becomes a delete capability again,
-- which is `DEV-049` in a new place.
--
-- A RESTRICTIVE policy is AND-ed with every permissive one, so it subtracts. It is the only
-- construct in RLS that can take away a privilege an existing policy confers - a second
-- permissive policy would be OR-ed and would grant nothing while looking like a control, which is
-- the shape `DEV-050` had.
--
-- `owned_item_update`'s USING requires `deleted_at IS NULL`, so any update reaching this check
-- started from a live row, and `deleted_at IS NOT NULL` in the new row means exactly "this
-- statement is deleting the item". An ordinary caregiver edit leaves the column NULL and the
-- restriction does not apply to it at all.
--
-- `db/retention.test.ts` measures this policy under the exact condition that makes it
-- load-bearing - the SELECT filter relaxed - because a guard tested only where something else
-- already refuses is a guard nobody has seen fire.

CREATE POLICY owned_item_delete_is_owner_only ON owned_item
  AS RESTRICTIVE
  FOR UPDATE TO kynviora_app
  USING (true)
  WITH CHECK (deleted_at IS NULL OR kynviora.owns_profile(profile_id));

-- The same subtraction on the other two soft-deletable profile tables. `allergy_update` and
-- `condition_update` admit `MANAGE_MEDICINES` and do not carry `deleted_at IS NULL` in their
-- USING clauses at all, so a caregiver there could also bring a deleted record back.

CREATE POLICY allergy_delete_is_owner_only ON allergy_record
  AS RESTRICTIVE
  FOR UPDATE TO kynviora_app
  USING (true)
  WITH CHECK (deleted_at IS NULL OR kynviora.owns_profile(profile_id));

CREATE POLICY condition_delete_is_owner_only ON condition_record
  AS RESTRICTIVE
  FOR UPDATE TO kynviora_app
  USING (true)
  WITH CHECK (deleted_at IS NULL OR kynviora.owns_profile(profile_id));

COMMENT ON COLUMN owned_item.deleted_at IS
  'Revocation stamp (DEC-117). Written only by kynviora.delete_owned_item, which requires the '
  'acting user to own the profile. Every SELECT policy filters on it, so the row is inaccessible '
  'and stops all processing the moment it is written; the bytes go on the purge schedule in '
  'docs/RETENTION.md.';

-- ---------------------------------------------------------------------------
-- 9. Finding what is due
-- ---------------------------------------------------------------------------
-- Partial indexes on the revocation stamps, so a purge sweep is a range scan over the rows that
-- have one rather than a sequential scan over every household's shelf. `WHERE deleted_at IS NOT
-- NULL` is the complement of the indexes `0002` and `0004` already built for the live reads.

CREATE INDEX owned_item_purge_idx ON owned_item (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX profile_purge_idx ON profile (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX household_purge_idx ON household (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX app_user_purge_idx ON app_user (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX allergy_record_purge_idx ON allergy_record (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX condition_record_purge_idx ON condition_record (deleted_at)
  WHERE deleted_at IS NOT NULL;
CREATE INDEX evidence_asset_purge_idx ON evidence_asset (deleted_at) WHERE deleted_at IS NOT NULL;

-- Expiry sweeps. A Visit Pack's content is purged within 24h of expiry and a caregiver invitation's
-- operational row within 30d, so both are found by an expiry range rather than by a stamp.
CREATE INDEX visit_pack_expiry_idx ON visit_pack (expires_at);
CREATE INDEX caregiver_invitation_expiry_idx ON caregiver_invitation (expires_at);

COMMENT ON TABLE consent_receipt IS
  'Append-only record of a consent decision (spec 16). Retained 24 months and purged only through '
  'the age-gated path in migration 0022, because a receipt that is deleted with its subject '
  'cannot show that consent was withdrawn (DEC-117). Its subject references are de-linked at '
  'purge rather than cascaded.';
