-- 0025_profile_deletion.sql
-- Removing a person from a household, and everything recorded about them (DEC-120, `DEV-036`).
--
-- Spec references: `16` (a person can have their data removed; the deletion workflow enumerates
-- what goes and what is retained), `14` (re-authentication for high-impact actions), `13`
-- (deletion orchestration is a privileged operation; a profile ID in a request is never proof of
-- access), `docs/RETENTION.md`, `0022`, `0023`.
--
-- WHAT THIS IS AND WHAT IT IS NOT
-- The second of the three deletion triggers in `docs/RETENTION.md` section 2. The first - one item
-- - landed in `0022`. The third, an account, is **not** here and cannot honestly be: deleting
-- `app_user` while Supabase still holds the identity produces somebody who can sign in to nothing,
-- and there are no credentials to delete the other half with (`BLK-010`). That boundary is real
-- and is recorded rather than approximated.
--
-- THE SHAPE IS `0022`'S, FOR THE REASONS `0022` GIVES
-- A revocation stamp rather than a hard delete, so the guarantee is synchronous and the bytes are
-- the purge's problem. Written through a function granted to the service role alone, because the
-- app role cannot write a `deleted_at` at all - Postgres applies the SELECT policies to the new row
-- of an UPDATE that reads the table, and `profile_select` filters `deleted_at IS NULL` (`DEV-057`).
-- Owner only, with no caregiver capability anywhere near it.

CREATE OR REPLACE FUNCTION kynviora.delete_profile(
  target_profile_id uuid,
  acting_user_id uuid
) RETURNS boolean
LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
  stamped boolean;
BEGIN
  UPDATE profile
     SET deleted_at = now()
   WHERE id = target_profile_id
     AND deleted_at IS NULL
     AND owner_user_id = acting_user_id
  RETURNING true INTO stamped;

  IF NOT coalesce(stamped, false) THEN
    RETURN false;
  END IF;

  -- The shelf goes with the person, and it is stamped **here** rather than left for the purge to
  -- work out. Two reasons, and the second is the load-bearing one:
  --
  -- 1. It is what the deletion means. A medicine belonging to a profile nobody can see is not a
  --    medicine anybody has, and an item whose own stamp was NULL would show up in any future
  --    query that joined by item rather than by profile.
  -- 2. Every child of an item reaches its purge door through `owned_item.deleted_at` (`0023`).
  --    A profile-only stamp would leave `dose_event` admitted by a profile-keyed policy and
  --    refused by an item-keyed trigger - the row visible to the sweep and undeletable, which is
  --    a purge that never completes and reports nothing.
  --
  -- The same instant, so the whole household becomes due for purge together rather than an item
  -- outliving the person by however long its own stamp was late.
  UPDATE owned_item
     SET deleted_at = now()
   WHERE profile_id = target_profile_id
     AND deleted_at IS NULL;

  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION kynviora.delete_profile(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kynviora.delete_profile(uuid, uuid) TO kynviora_service;

COMMENT ON FUNCTION kynviora.delete_profile(uuid, uuid) IS
  'Revocation stamp for a profile (DEC-120). The owner only - a caregiver may change what a record '
  'says and never make it stop existing. Ownership is compared here rather than by a caller, so '
  'the privileged write cannot be wider than the check that authorised it.';

-- `owns_profile` is deliberately not used. It reads `profile` under `SECURITY DEFINER` and would
-- answer the same question, and it also short-circuits every capability check in the system - so
-- calling it from the one function that removes a profile would tie the deletion path to the
-- access path, and a future change to one would silently change the other. The comparison here is
-- three columns and is the whole rule.

-- ---------------------------------------------------------------------------
-- Purging a deleted profile
-- ---------------------------------------------------------------------------
-- The same shape `0023` gives an item, one level up. A profile's children are a longer list and
-- three of them are append-only, so each gets the parent-gated door rather than a cascade - for
-- the reason `0023` gives, which is that a referential action runs as the owner of the referencing
-- table and not as the session's role.

CREATE OR REPLACE FUNCTION kynviora.profile_is_due_for_purge(target_profile_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profile p
     WHERE p.id = target_profile_id
       AND p.deleted_at IS NOT NULL
       AND p.deleted_at <= kynviora.purge_floor()
  );
$$;

REVOKE ALL ON FUNCTION kynviora.profile_is_due_for_purge(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kynviora.profile_is_due_for_purge(uuid) TO kynviora_retention;

-- The append-only children of a profile. Each gains door three keyed on `profile_id`, exactly as
-- `dose_event` gained one keyed on `owned_item_id`.
--
-- `alert_delivery` and `notification_revalidation` are the two that record that somebody was told
-- something. They go with the profile because they are about this person's alerts; the record that
-- the *deletion* happened lives in `audit_event`, which outlives it by 24 months (DEC-117).

DROP TRIGGER alert_delivery_append_only ON alert_delivery;
CREATE TRIGGER alert_delivery_append_only
  BEFORE UPDATE OR DELETE ON alert_delivery
  FOR EACH ROW EXECUTE FUNCTION kynviora.forbid_mutation('purge_with', 'profile_id', 'profile');

GRANT SELECT, DELETE ON profile TO kynviora_retention;
GRANT SELECT, DELETE ON allergy_record, condition_record, alert_publication, alert_delivery,
      caregiver_grant, caregiver_invitation, reconciliation, visit_pack,
      profile_notification_policy, notification_preference, safety_receipt
  TO kynviora_retention;

CREATE POLICY profile_purge ON profile
  FOR SELECT TO kynviora_retention
  USING (deleted_at IS NOT NULL AND deleted_at <= kynviora.purge_floor());
CREATE POLICY profile_purge_delete ON profile
  FOR DELETE TO kynviora_retention
  USING (deleted_at IS NOT NULL AND deleted_at <= kynviora.purge_floor());

-- One predicate per table, all of them the same question. Written out rather than generated,
-- because a policy is the thing standing between this role and somebody's live health record and
-- it should be readable without running anything.
CREATE POLICY allergy_purge ON allergy_record
  FOR SELECT TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));
CREATE POLICY allergy_purge_delete ON allergy_record
  FOR DELETE TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));

CREATE POLICY condition_purge ON condition_record
  FOR SELECT TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));
CREATE POLICY condition_purge_delete ON condition_record
  FOR DELETE TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));

CREATE POLICY alert_publication_purge ON alert_publication
  FOR SELECT TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));
CREATE POLICY alert_publication_purge_delete ON alert_publication
  FOR DELETE TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));

CREATE POLICY alert_delivery_purge ON alert_delivery
  FOR SELECT TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));
CREATE POLICY alert_delivery_purge_delete ON alert_delivery
  FOR DELETE TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));

CREATE POLICY safety_receipt_purge ON safety_receipt
  FOR SELECT TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));
CREATE POLICY safety_receipt_purge_delete ON safety_receipt
  FOR DELETE TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));

CREATE POLICY caregiver_grant_purge ON caregiver_grant
  FOR SELECT TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));
CREATE POLICY caregiver_grant_purge_delete ON caregiver_grant
  FOR DELETE TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));

-- Already purgeable on its own 30-days-past-expiry clock (`0023`). This adds the second reason:
-- an invitation to a profile that is gone goes with it, whether or not it has expired.
CREATE POLICY invitation_profile_purge ON caregiver_invitation
  FOR SELECT TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));
CREATE POLICY invitation_profile_purge_delete ON caregiver_invitation
  FOR DELETE TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));

CREATE POLICY reconciliation_purge ON reconciliation
  FOR SELECT TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));
CREATE POLICY reconciliation_purge_delete ON reconciliation
  FOR DELETE TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));

CREATE POLICY visit_pack_profile_purge ON visit_pack
  FOR SELECT TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));
CREATE POLICY visit_pack_profile_purge_delete ON visit_pack
  FOR DELETE TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));

CREATE POLICY notification_policy_purge ON profile_notification_policy
  FOR SELECT TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));
CREATE POLICY notification_policy_purge_delete ON profile_notification_policy
  FOR DELETE TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));

CREATE POLICY notification_preference_purge ON notification_preference
  FOR SELECT TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));
CREATE POLICY notification_preference_purge_delete ON notification_preference
  FOR DELETE TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));

-- `owned_item` needs no profile-keyed policy: `delete_profile` stamps every item at the same
-- instant, so `0023`'s item-level policies find them and their children follow through the doors
-- they already have.
--
-- `review_task` does need one, and only for half its rows: `owned_item_id` is nullable, so a task
-- about a profile rather than an item has no item to be purged with.

CREATE POLICY review_task_profile_purge ON review_task
  FOR SELECT TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));
CREATE POLICY review_task_profile_purge_delete ON review_task
  FOR DELETE TO kynviora_retention USING (kynviora.profile_is_due_for_purge(profile_id));

-- `profile_assessment` needs none either: its `owned_item_id` is NOT NULL, so every row of it
-- belongs to an item the statement above has already stamped.

COMMENT ON COLUMN profile.deleted_at IS
  'Revocation stamp (DEC-120). Written only by kynviora.delete_profile, which requires the acting '
  'user to own the profile. Every SELECT policy filters on it, so the person disappears from the '
  'switcher and every child read returns nothing the moment it is written.';
