-- 0023_purge.sql
-- The second half of a deletion: the bytes (DEC-117, `docs/RETENTION.md`, `DEV-058`).
--
-- Spec references: `16` (retention deadlines; a deletion workflow enumerates what goes),
-- `14` (least privilege), DEC-013 (append-only), `0022`.
--
-- WHAT `0022` LEFT
-- Revocation: the stamp that makes a record inaccessible and stops all processing, synchronously.
-- That is the promise made to a person and it is complete.
--
-- What it did not build is the purge, and building it turned up the same wall `0022` hit at
-- `consent_receipt`, one layer down: **an item cannot be deleted because its children refuse to
-- be**. `dose_event` and `product_usage_evidence` are append-only by trigger and cascade from
-- `owned_item`, so a hard `DELETE` of a purgeable item raises "append-only" from a table nobody
-- was asking about. The 30-day deadline in the matrix was therefore unmeetable by construction,
-- and nothing said so.
--
-- WHY THE PURGE DOES NOT USE THE CASCADES IT HAS
-- It could, and it must not. A referential action runs as the owner of the referencing table
-- rather than as the session's role, so `current_user` inside a cascaded child's trigger is not
-- the role that issued the statement - which makes any role check in that trigger measure the
-- wrong thing, and measure it differently depending on how the database was provisioned
-- (`BLK-001`). A door that opens for a superuser-owned table and not for a role-owned one is a
-- door nobody can reason about.
--
-- So the sweep deletes children explicitly, deepest first, and the parent last. Each statement is
-- issued by `kynviora_retention` itself, so the role check means what it says; the order is
-- visible in one place rather than implied by a graph of foreign keys; and a child that gains a
-- new table later fails loudly on the parent's `DELETE` rather than being silently removed by a
-- cascade nobody reviewed.

-- ---------------------------------------------------------------------------
-- 1. The purge floor
-- ---------------------------------------------------------------------------
-- 30 days from the revocation stamp, per `docs/RETENTION.md` section 3.1. Defined once, beside
-- `retention_floor`, so the two deadlines cannot be confused for one another - they are 30 days
-- and 24 months, and a single "floor" function would have been the shortest possible way to
-- delete an audit log by accident.

CREATE OR REPLACE FUNCTION kynviora.purge_floor() RETURNS timestamptz
LANGUAGE sql STABLE
AS $$
  SELECT now() - interval '30 days';
$$;

COMMENT ON FUNCTION kynviora.purge_floor() IS
  'A revocation stamp at or before this is due for purge (DEC-117). Distinct from '
  'retention_floor, which is 24 months and governs the two tables that outlive a deletion.';

GRANT EXECUTE ON FUNCTION kynviora.purge_floor() TO
  kynviora_app, kynviora_service, kynviora_retention;

-- ---------------------------------------------------------------------------
-- 2. Door three: a child follows its parent
-- ---------------------------------------------------------------------------
-- The append-only trigger gains one more case, and it is as narrow as the other two: a `DELETE`,
-- by `kynviora_retention`, of a row whose **parent** carries a revocation stamp at or before the
-- purge floor.
--
-- The child's own age is deliberately not consulted. A dose recorded this morning against a
-- medicine deleted five weeks ago is due for purge, because what is being removed is the
-- medicine and everything about it - and a child that outlived its parent would be a dose history
-- for a medicine nobody can name.
--
-- Opted into per table by trigger arguments, exactly as the other two doors are. A table with no
-- arguments keeps the behaviour it has always had.

CREATE OR REPLACE FUNCTION kynviora.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ts_column     text;
  row_ts        timestamptz;
  delinkable    text[];
  column_name   text;
  is_delink     boolean;
  old_rest      jsonb;
  new_rest      jsonb;
  parent_id     uuid;
  parent_due    boolean;
BEGIN
  IF TG_OP = 'DELETE' AND TG_NARGS >= 1
     AND pg_has_role(current_user, 'kynviora_retention', 'MEMBER')
  THEN

    -- Which door a table has is decided by its **first** argument, not by how many it has. That
    -- distinction is load-bearing: `consent_receipt` carries three arguments for door two's sake
    -- (`recorded_at`, `user_id`, `profile_id`) and must still reach door one, and a dispatch
    -- keyed on argument count silently dropped it into the blanket refusal - a table that was
    -- purgeable one migration ago quietly ceasing to be.

    -- Door one: retention. A row of a retained table, past the 24-month floor.
    IF TG_ARGV[0] <> 'purge_with' THEN
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

    -- Door three: a child of a purgeable parent. TG_ARGV is
    -- ('purge_with', <parent id column>, <parent table>).
    IF TG_NARGS = 3 THEN
      EXECUTE format('SELECT ($1).%I', TG_ARGV[1]) INTO parent_id USING OLD;

      EXECUTE format(
        'SELECT EXISTS (SELECT 1 FROM %I p WHERE p.id = $1
                          AND p.deleted_at IS NOT NULL
                          AND p.deleted_at <= kynviora.purge_floor())',
        TG_ARGV[2]
      ) INTO parent_due USING parent_id;

      IF parent_due THEN
        RETURN OLD;
      END IF;

      RAISE EXCEPTION
        'Row in % belongs to a % that is not due for purge (see DEC-117).',
        TG_TABLE_NAME, TG_ARGV[2]
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- Door two: de-linking. An UPDATE that clears the declared subject columns and changes nothing
  -- else at all - what an `ON DELETE SET NULL` foreign key performs when a subject is purged.
  --
  -- Recognised by shape, and the shape is the whole guarantee: every declared column ends NULL,
  -- and stripping those columns from both versions leaves two identical rows. Nothing can move
  -- under cover of a de-link, and a declared column cannot be re-pointed at a different subject.
  IF TG_OP = 'UPDATE' AND TG_NARGS > 1 AND TG_ARGV[0] <> 'purge_with' THEN
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

-- The two append-only children of `owned_item`. Both keep their refusal of every UPDATE and of
-- every DELETE by anybody else; what they gain is the one case where the medicine they belong to
-- is thirty days gone.

DROP TRIGGER dose_event_append_only ON dose_event;
CREATE TRIGGER dose_event_append_only
  BEFORE UPDATE OR DELETE ON dose_event
  FOR EACH ROW EXECUTE FUNCTION kynviora.forbid_mutation('purge_with', 'owned_item_id', 'owned_item');

DROP TRIGGER product_usage_evidence_append_only ON product_usage_evidence;
CREATE TRIGGER product_usage_evidence_append_only
  BEFORE UPDATE OR DELETE ON product_usage_evidence
  FOR EACH ROW EXECUTE FUNCTION kynviora.forbid_mutation('purge_with', 'owned_item_id', 'owned_item');

-- `profile_assessment` is the third append-only child of an item, and it is also a child of a
-- profile. It is keyed on the item here because that is the deletion this build can perform;
-- profile deletion is not built (`DEV-036`), and a door declared for a parent nothing stamps
-- would be a door that has never been opened.
DROP TRIGGER profile_assessment_append_only ON profile_assessment;
CREATE TRIGGER profile_assessment_append_only
  BEFORE UPDATE OR DELETE ON profile_assessment
  FOR EACH ROW EXECUTE FUNCTION kynviora.forbid_mutation('purge_with', 'owned_item_id', 'owned_item');

-- ---------------------------------------------------------------------------
-- 3. What the retention role may purge
-- ---------------------------------------------------------------------------
-- Grants, table by table, and no wider than the sweep needs. SELECT accompanies every DELETE
-- because a sweep has to find its rows, and a role that could delete what it could not read would
-- be one nobody could test.
--
-- Every one of these tables holds personal data, which is a change from `0022` where the role
-- read only identifiers and versions. That is the cost of the role doing the purge at all, and it
-- is bounded in the one way that matters: **there is no policy admitting a row that is not due**.
-- The role can read a dose event whose medicine was deleted five weeks ago and nothing else.

GRANT SELECT, DELETE ON owned_item TO kynviora_retention;
GRANT SELECT, DELETE ON dose_event TO kynviora_retention;
GRANT SELECT, DELETE ON medicine_schedule TO kynviora_retention;
GRANT SELECT, DELETE ON refill_estimate TO kynviora_retention;
GRANT SELECT, DELETE ON product_usage_evidence TO kynviora_retention;
GRANT SELECT, DELETE ON review_task TO kynviora_retention;
GRANT SELECT, DELETE ON profile_assessment TO kynviora_retention;

-- Time-boxed artifacts, which expire on their own clock rather than on a deletion.
GRANT SELECT, UPDATE ON visit_pack TO kynviora_retention;
GRANT SELECT, DELETE ON caregiver_invitation TO kynviora_retention;
GRANT SELECT, DELETE ON evidence_asset TO kynviora_retention;
GRANT SELECT, DELETE ON extraction_run TO kynviora_retention;

-- ---------------------------------------------------------------------------
-- 4. The policies, each one a deadline
-- ---------------------------------------------------------------------------
-- Deny by default is what makes this role safe. Every policy below admits exactly the rows the
-- matrix says are due, so a sweep with a bug in its WHERE clause removes nothing rather than
-- removing somebody's shelf: the widest possible statement this role can issue is
-- `DELETE FROM owned_item` with no predicate at all, and that deletes only items whose owner
-- deleted them more than thirty days ago.

CREATE POLICY owned_item_purge ON owned_item
  FOR SELECT TO kynviora_retention
  USING (deleted_at IS NOT NULL AND deleted_at <= kynviora.purge_floor());

CREATE POLICY owned_item_purge_delete ON owned_item
  FOR DELETE TO kynviora_retention
  USING (deleted_at IS NOT NULL AND deleted_at <= kynviora.purge_floor());

-- The children. One predicate, written once as a helper so a table added later cannot get a
-- subtly different version of it.
CREATE OR REPLACE FUNCTION kynviora.item_is_due_for_purge(target_item_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM owned_item i
     WHERE i.id = target_item_id
       AND i.deleted_at IS NOT NULL
       AND i.deleted_at <= kynviora.purge_floor()
  );
$$;

REVOKE ALL ON FUNCTION kynviora.item_is_due_for_purge(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kynviora.item_is_due_for_purge(uuid) TO kynviora_retention;

CREATE POLICY dose_event_purge ON dose_event
  FOR SELECT TO kynviora_retention
  USING (kynviora.item_is_due_for_purge(owned_item_id));
CREATE POLICY dose_event_purge_delete ON dose_event
  FOR DELETE TO kynviora_retention
  USING (kynviora.item_is_due_for_purge(owned_item_id));

CREATE POLICY schedule_purge ON medicine_schedule
  FOR SELECT TO kynviora_retention
  USING (kynviora.item_is_due_for_purge(owned_item_id));
CREATE POLICY schedule_purge_delete ON medicine_schedule
  FOR DELETE TO kynviora_retention
  USING (kynviora.item_is_due_for_purge(owned_item_id));

CREATE POLICY refill_purge ON refill_estimate
  FOR SELECT TO kynviora_retention
  USING (kynviora.item_is_due_for_purge(owned_item_id));
CREATE POLICY refill_purge_delete ON refill_estimate
  FOR DELETE TO kynviora_retention
  USING (kynviora.item_is_due_for_purge(owned_item_id));

CREATE POLICY usage_evidence_purge ON product_usage_evidence
  FOR SELECT TO kynviora_retention
  USING (kynviora.item_is_due_for_purge(owned_item_id));
CREATE POLICY usage_evidence_purge_delete ON product_usage_evidence
  FOR DELETE TO kynviora_retention
  USING (kynviora.item_is_due_for_purge(owned_item_id));

-- `review_task.owned_item_id` is nullable - a task can be about a profile rather than an item -
-- so the predicate has to say so. A task with no item is not purged by an item's deadline and
-- must not be; it belongs to the profile purge, which does not exist yet.
CREATE POLICY review_task_purge ON review_task
  FOR SELECT TO kynviora_retention
  USING (owned_item_id IS NOT NULL AND kynviora.item_is_due_for_purge(owned_item_id));
CREATE POLICY review_task_purge_delete ON review_task
  FOR DELETE TO kynviora_retention
  USING (owned_item_id IS NOT NULL AND kynviora.item_is_due_for_purge(owned_item_id));

CREATE POLICY assessment_purge ON profile_assessment
  FOR SELECT TO kynviora_retention
  USING (kynviora.item_is_due_for_purge(owned_item_id));
CREATE POLICY assessment_purge_delete ON profile_assessment
  FOR DELETE TO kynviora_retention
  USING (kynviora.item_is_due_for_purge(owned_item_id));

-- ---------------------------------------------------------------------------
-- 5. Visit Pack content, 24 hours after expiry
-- ---------------------------------------------------------------------------
-- `docs/RETENTION.md` section 3.2. The **content** goes - the manifest and the notes, which are
-- the pack - and the row stays to the profile's own 30-day boundary so that "a pack was created
-- and has expired" remains answerable without the pack being readable.
--
-- An UPDATE rather than a DELETE, and the constraints make it awkward in a way worth naming:
-- `visit_pack_not_empty` requires a manifest entry or a note, so the manifest cannot simply be
-- emptied. It becomes the empty **array**, which satisfies `visit_pack_manifest_is_array` and
-- fails `visit_pack_not_empty` - so that constraint is replaced with one that exempts a purged
-- pack. The alternative was dropping the constraint outright, which would let an empty pack be
-- *created*, and `04` Phase 8.4's "export never happens automatically" rests on it.

ALTER TABLE visit_pack ADD COLUMN content_purged_at timestamptz;

ALTER TABLE visit_pack DROP CONSTRAINT visit_pack_not_empty;
ALTER TABLE visit_pack
  ADD CONSTRAINT visit_pack_not_empty CHECK (
    content_purged_at IS NOT NULL
    OR jsonb_array_length(manifest) > 0
    OR cardinality(notes) > 0
  );

-- Not a whole-row UPDATE. The sweep writes three columns; the WITH CHECK requires the purge stamp,
-- so an UPDATE through this role cannot leave a pack looking un-purged.
--
-- THE SELECT POLICY DELIBERATELY DOES NOT MENTION `content_purged_at`, AND `DEV-057` IS WHY
-- Postgres applies the SELECT policies to the **new** row of an UPDATE that reads the table. A
-- SELECT policy carrying `content_purged_at IS NULL` would therefore refuse the very statement
-- that sets it - the same shape that made a soft delete unwritable by its owner, arriving in a
-- second place two migrations later. It is worth naming rather than fixing quietly: any policy
-- pair where the SELECT predicate mentions the column the UPDATE writes has this defect, and it
-- presents as "new row violates row-level security policy" on a statement that is entirely
-- correct.
--
-- Idempotence lives in the UPDATE policy's USING clause and in the sweep's own predicate instead,
-- which is where it belongs: a second sweep matches no rows rather than being refused.
CREATE POLICY visit_pack_purge ON visit_pack
  FOR SELECT TO kynviora_retention
  USING (expires_at <= now() - interval '24 hours');

CREATE POLICY visit_pack_purge_update ON visit_pack
  FOR UPDATE TO kynviora_retention
  USING (expires_at <= now() - interval '24 hours' AND content_purged_at IS NULL)
  WITH CHECK (content_purged_at IS NOT NULL);

COMMENT ON COLUMN visit_pack.content_purged_at IS
  'When the manifest and notes were purged, 24 hours after expiry (DEC-117). The row survives to '
  'the profile boundary so that a pack having existed and expired stays answerable.';

-- ---------------------------------------------------------------------------
-- 6. Caregiver invitations, 30 days after they stop being usable
-- ---------------------------------------------------------------------------
-- The operational row goes; the access history stays in `audit_event`, which is the point of the
-- split. An invitation that was accepted has become a grant, and the grant is what carries the
-- access - so the row here is the offer, and an offer nobody can accept any more is bookkeeping.
--
-- `expires_at` is NOT NULL by construction (`0007`: "an invitation that never expires is a
-- permanent credential sitting in an inbox"), so a single predicate covers every terminal state:
-- expired, declined and revoked invitations all stop being usable at or before their expiry.

CREATE POLICY invitation_purge ON caregiver_invitation
  FOR SELECT TO kynviora_retention
  USING (expires_at <= now() - interval '30 days');

CREATE POLICY invitation_purge_delete ON caregiver_invitation
  FOR DELETE TO kynviora_retention
  USING (expires_at <= now() - interval '30 days');

-- ---------------------------------------------------------------------------
-- 7. Unattached capture artifacts, 7 days
-- ---------------------------------------------------------------------------
-- `docs/RETENTION.md` section 3.2. An `evidence_asset` that never became part of an item is a
-- photograph of somebody's medicine with nothing pointing at it, and there is no surface on which
-- it is ever shown again.
--
-- "Unattached" is a subtraction and has to be exact: nothing in `product_usage_evidence`,
-- `field_assertion`, `product_observation` or `reconciliation` may reference it. A predicate that
-- missed one of those would delete an asset a Trust Passport still cites.
--
-- WHY THE CHECK IS A FUNCTION AND NOT FOUR SUBQUERIES IN THE POLICY
-- A subquery inside a policy runs as the caller, so it is filtered by the *referencing* table's
-- own policies. `product_usage_evidence`'s retention policy admits only rows belonging to a
-- purgeable item - so an asset referenced by evidence for a **live** item would look unreferenced
-- to the subquery, and the sweep would delete it. The answer would be wrong in the one direction
-- that loses data, and it would be wrong silently.
--
-- Fixing that by giving the role a blanket read on all four tables would widen it from "may read
-- what is due for purge" to "may read every piece of evidence in the system", which is most of
-- what `0022`'s narrow role was for. `SECURITY DEFINER` answers the question without either: the
-- role learns one boolean about one asset and gains no way to read a row.

CREATE OR REPLACE FUNCTION kynviora.evidence_is_unattached(target_asset_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT NOT EXISTS (SELECT 1 FROM product_usage_evidence e WHERE e.evidence_asset_id = target_asset_id)
     AND NOT EXISTS (SELECT 1 FROM field_assertion f WHERE f.evidence_asset_id = target_asset_id)
     AND NOT EXISTS (SELECT 1 FROM product_observation o WHERE o.evidence_asset_id = target_asset_id)
     AND NOT EXISTS (SELECT 1 FROM reconciliation r WHERE r.source_evidence_asset_id = target_asset_id);
$$;

REVOKE ALL ON FUNCTION kynviora.evidence_is_unattached(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kynviora.evidence_is_unattached(uuid) TO kynviora_retention;

CREATE POLICY evidence_purge ON evidence_asset
  FOR SELECT TO kynviora_retention
  USING (created_at <= now() - interval '7 days' AND kynviora.evidence_is_unattached(id));

CREATE POLICY evidence_purge_delete ON evidence_asset
  FOR DELETE TO kynviora_retention
  USING (created_at <= now() - interval '7 days' AND kynviora.evidence_is_unattached(id));

-- `extraction_run` cascades from `evidence_asset` and has no append-only trigger, so it follows
-- its asset without a door. The grant exists so the sweep can count what it removed.
CREATE POLICY extraction_purge ON extraction_run
  FOR SELECT TO kynviora_retention USING (true);
CREATE POLICY extraction_purge_delete ON extraction_run
  FOR DELETE TO kynviora_retention USING (true);
