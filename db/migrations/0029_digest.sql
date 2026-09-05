-- 0029_digest.sql
-- The digest: what MEDIUM and LOW events become instead of a phone lighting up (`DEV-033`).
--
-- Spec references: `04` Phase 7.5 (digest policy for lower urgency; a stale or corrected
-- notification cannot remain actionable without revalidation), `09` (a withdrawn alert stops being
-- actionable), `16` (a notification reveals minimal information; retention), `02`, DEC-119,
-- DEC-121, `0009`, `0014`, `0028`.
--
-- WHAT WAS ALREADY TRUE
-- `MEDIUM` and `LOW` map to the digest channel, `dispatchAlert` sends nothing for them, and since
-- `0028` each delivery records the channel it took. So the candidate set exists. What has never
-- existed is anything that gathers it.
--
-- WHAT A DIGEST ROW IS
-- A record of what accumulated for one person over one of **their own** days, revalidated at the
-- moment it was assembled. It is not a delivery: nothing sends it (`BLK-009`). What assembling
-- adds is the half `04` Phase 7.5 specifies - a summary checked against reality when it is
-- presented, rather than a list of notifications that were true when they were classified.
--
-- WHY THERE IS A ROW PER CANDIDATE AND NOT PER INCLUDED ITEM
-- Two reasons, and the second is the one that matters.
--
-- "Why is this not in my digest" is a question a digest generates, and it is unanswerable from a
-- list of what survived. Recording the revalidation outcome answers it.
--
-- And it is what stops a dropped item being reconsidered every morning for the rest of time. An
-- alert withdrawn on Tuesday is still withdrawn on Wednesday; a candidate query that asked only
-- "which deliveries are in no digest" would re-examine it daily and re-answer a settled question
-- daily. `UNIQUE (alert_delivery_id)` makes considered-once a property of the schema.
--
-- WHY NO LEASE AND NO RUN HISTORY
-- Unlike the purge (DEC-121), this job's idempotence is a **unique index rather than a lock**. Two
-- workers assembling the same recipient's digest for the same local date produce one row and one
-- loser, and a delivery can be considered by exactly one digest ever. So there is nothing for a
-- lease to protect, and a second run-history table would record the same fact the digest rows
-- already record: whether a digest exists for a given person and day.

-- ---------------------------------------------------------------------------
-- 1. The digest
-- ---------------------------------------------------------------------------
-- Keyed on the recipient and **their** local date, which is the whole of the cadence: one digest
-- per person per day, in their own morning. A person who changes time zone across a day boundary
-- can get two, and that is the right failure - the alternative is a day of theirs with no digest
-- because a server-local date said they had already had one.

CREATE TABLE notification_digest (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  -- `YYYY-MM-DD` in the recipient's zone, computed by `recipientLocalDate`. A date rather than a
  -- timestamp because that is what "one per day" is keyed on, and a timestamp would invite a
  -- second definition of the same day.
  local_date        date NOT NULL,
  -- The zone that decided it, recorded so the date is interpretable a year later. `16`'s
  -- minimisation is satisfied the same way `app_user.time_zone` satisfies it: a zone is coarse and
  -- is here for one stated purpose.
  time_zone         text NOT NULL,
  assembled_at      timestamptz NOT NULL DEFAULT now(),
  included_count    integer NOT NULL DEFAULT 0,
  dropped_count     integer NOT NULL DEFAULT 0,
  -- `BLK-009`. NULL, and it will stay NULL until push credentials exist. The column is here rather
  -- than added later because "assembled" and "delivered" are different facts and a digest that
  -- could not distinguish them would be one nobody could audit once sending starts.
  delivered_at      timestamptz,

  CONSTRAINT notification_digest_once_per_local_day UNIQUE (recipient_user_id, local_date),
  CONSTRAINT notification_digest_counts_non_negative
    CHECK (included_count >= 0 AND dropped_count >= 0),
  -- A digest with nothing in it is not assembled at all. Two reasons, and the second is load
  -- bearing: a summary saying "nothing happened", which nothing sends, is noise - and the purge
  -- below removes a digest once it has no entries left, so an empty one would be created and
  -- deleted on the same day for two entirely different reasons. Both counts are known before the
  -- row is written, because the assembly is pure and runs first.
  CONSTRAINT notification_digest_not_empty CHECK (included_count + dropped_count > 0)
);

COMMENT ON TABLE notification_digest IS
  'One assembled digest per recipient per recipient-local day (04 Phase 7.5, DEV-033). Holds '
  'counts and a date; the events themselves are referenced through notification_digest_entry, so '
  'nothing renderable is stored - the same rule alert_delivery follows.';

CREATE INDEX notification_digest_recipient_idx
  ON notification_digest (recipient_user_id, local_date DESC);

-- ---------------------------------------------------------------------------
-- 2. One row per candidate considered
-- ---------------------------------------------------------------------------
-- No title, no body, no medicine, no person. A digest entry is a **reference** plus what a re-read
-- found, exactly as `alert_delivery` is a reference plus a detail level - so a digest can never
-- disclose more than a live read would, because it holds nothing to disclose.

CREATE TABLE notification_digest_entry (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  digest_id         uuid NOT NULL REFERENCES notification_digest (id) ON DELETE CASCADE,
  alert_delivery_id uuid NOT NULL REFERENCES alert_delivery (id) ON DELETE CASCADE,
  -- What a re-read as the recipient found. `STILL_CURRENT` is the only one that is included.
  outcome           text NOT NULL,
  included          boolean NOT NULL,

  -- Considered exactly once, ever. Not per digest: per delivery, across all of them.
  CONSTRAINT notification_digest_entry_once UNIQUE (alert_delivery_id),
  CONSTRAINT notification_digest_entry_outcome_valid CHECK (outcome IN (
    'STILL_CURRENT', 'WITHDRAWN', 'SUPERSEDED', 'CORRECTED_SINCE_NOTIFICATION', 'NO_LONGER_VISIBLE'
  )),
  -- Included and still-current are the same statement. Two columns that could disagree would be
  -- two definitions of "still true", and the digest is the place that distinction is load-bearing.
  CONSTRAINT notification_digest_entry_included_is_current
    CHECK (included = (outcome = 'STILL_CURRENT'))
);

CREATE INDEX notification_digest_entry_digest_idx
  ON notification_digest_entry (digest_id);

-- ---------------------------------------------------------------------------
-- 3. Who may read and write
-- ---------------------------------------------------------------------------
-- The recipient reads their own, and nobody else's - not the profile owner, and not a caregiver.
-- A digest is addressed to one person: it spans every profile they have any access to, so
-- "somebody who can see this profile" is the wrong scope for it and would let a caregiver read a
-- summary of a household they are only partly inside.
--
-- Only the service role writes. Assembly is a server operation spanning every recipient, which is
-- what `13` names the service role for, and nothing a client does should be able to create a
-- digest or edit one.

ALTER TABLE notification_digest ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_digest FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_digest_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_digest_entry FORCE ROW LEVEL SECURITY;

GRANT SELECT ON notification_digest TO kynviora_app;
GRANT SELECT ON notification_digest_entry TO kynviora_app;
GRANT SELECT, INSERT, UPDATE ON notification_digest TO kynviora_service;
GRANT SELECT, INSERT ON notification_digest_entry TO kynviora_service;

CREATE POLICY notification_digest_read ON notification_digest
  FOR SELECT TO kynviora_app
  USING (recipient_user_id = kynviora.current_user_id());

CREATE POLICY notification_digest_service ON notification_digest
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

-- An entry is readable exactly where its digest is. Written as a lookup through the parent rather
-- than by repeating the recipient check, so the two cannot drift into a state where an entry is
-- visible and its digest is not.
CREATE POLICY notification_digest_entry_read ON notification_digest_entry
  FOR SELECT TO kynviora_app
  USING (EXISTS (
    SELECT 1 FROM notification_digest d
     WHERE d.id = digest_id AND d.recipient_user_id = kynviora.current_user_id()
  ));

CREATE POLICY notification_digest_entry_service ON notification_digest_entry
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 4. Retention
-- ---------------------------------------------------------------------------
-- `docs/RETENTION.md` section 3.1. A digest is a **derived projection of `alert_delivery`**, so it
-- inherits that table's deadline rather than acquiring one of its own - which is the honest
-- reading and also avoids inventing a threshold nobody approved.
--
-- The entries go with the deliveries they reference: `alert_delivery` is purged thirty days after
-- the profile it belongs to was deleted, and an entry pointing at a delivery that no longer exists
-- is a dangling reference to a record somebody asked to have removed.
--
-- The digest row itself goes when it has no entries left. Not on a clock: a digest whose every
-- entry has been purged is a count of nothing, and one that still has entries is still about
-- events that are still retained.
--
-- WHY THE SWEEP DELETES THESE EXPLICITLY RATHER THAN LETTING THE CASCADE DO IT
-- `0023`'s reason, unchanged: a referential action runs as the owner of the referencing table
-- rather than as the session's role, so a cascade from `alert_delivery` would be issued by
-- somebody other than `kynviora_retention` and any role check inside it would measure the wrong
-- thing. The sweep names both tables, deepest first.

GRANT SELECT, DELETE ON notification_digest TO kynviora_retention;
GRANT SELECT, DELETE ON notification_digest_entry TO kynviora_retention;

-- An entry is due when the delivery it references is due, which is the same predicate
-- `alert_delivery`'s own purge policy uses - reached through the parent so the two cannot drift.
CREATE OR REPLACE FUNCTION kynviora.digest_entry_is_due_for_purge(target_delivery_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM alert_delivery d
     WHERE d.id = target_delivery_id
       AND kynviora.profile_is_due_for_purge(d.profile_id)
  );
$$;

REVOKE ALL ON FUNCTION kynviora.digest_entry_is_due_for_purge(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kynviora.digest_entry_is_due_for_purge(uuid) TO kynviora_retention;

CREATE POLICY digest_entry_purge ON notification_digest_entry
  FOR SELECT TO kynviora_retention
  USING (kynviora.digest_entry_is_due_for_purge(alert_delivery_id));
CREATE POLICY digest_entry_purge_delete ON notification_digest_entry
  FOR DELETE TO kynviora_retention
  USING (kynviora.digest_entry_is_due_for_purge(alert_delivery_id));

-- A digest with no entries. `SECURITY DEFINER` for the reason `0023` gives at
-- `evidence_is_unattached`: a subquery inside a policy runs as the caller and would be filtered by
-- the entry table's **own** retention policy, so a digest whose entries all belong to live
-- profiles would look empty to it and be deleted. Wrong in the direction that loses data, and
-- wrong silently.
CREATE OR REPLACE FUNCTION kynviora.digest_is_empty(target_digest_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM notification_digest_entry e WHERE e.digest_id = target_digest_id
  );
$$;

REVOKE ALL ON FUNCTION kynviora.digest_is_empty(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kynviora.digest_is_empty(uuid) TO kynviora_retention;

CREATE POLICY digest_purge ON notification_digest
  FOR SELECT TO kynviora_retention USING (kynviora.digest_is_empty(id));
CREATE POLICY digest_purge_delete ON notification_digest
  FOR DELETE TO kynviora_retention USING (kynviora.digest_is_empty(id));

-- ---------------------------------------------------------------------------
-- 5. The sweep learns two more names
-- ---------------------------------------------------------------------------
-- `DIGEST` is a category of its own rather than a step inside `PROFILE`, because the two halves
-- run either side of it: an **entry** must be deleted before the `alert_delivery` it references
-- (it cascades, and a cascade is issued by the table's owner rather than by the retention role -
-- `0023`), so it belongs in `PROFILE`; the **digest** can only be removed once its entries are
-- gone, so it belongs after. A failure in one is then a failure about one, which is the whole
-- reason the sweep has categories (DEC-121).

ALTER TABLE retention_run_category DROP CONSTRAINT retention_run_category_valid;
ALTER TABLE retention_run_category
  ADD CONSTRAINT retention_run_category_valid CHECK (category IN (
    'ITEM', 'PROFILE', 'VISIT_PACK_CONTENT', 'CAREGIVER_INVITATION',
    'CAPTURE_ARTIFACT', 'DIGEST', 'AUDIT_EVENT', 'CONSENT_RECEIPT'
  ));
