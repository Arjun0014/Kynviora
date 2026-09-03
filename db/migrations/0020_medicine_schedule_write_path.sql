-- 0020_medicine_schedule_write_path.sql
-- Giving `medicine_schedule` the two columns a write path needs (spec 04 Phase 4.1, spec 13).
--
-- Spec references: 13 ("idempotency key on mutations that can be retried"; "server commits exactly
-- once"; conflict policy per entity type), 04 Phase 4.1 and 4.2, 12 (sync metadata).
--
-- WHY THIS ARRIVES SIXTEEN MIGRATIONS AFTER THE TABLE
-- 0004 created `medicine_schedule` with its constraints and its policies, and
-- `packages/safety/src/schedule.ts` has computed occurrences from it since Stage 4 with
-- deterministic tests. Nothing ever wrote a row, because no route existed - so Phase 4.1's model
-- was complete and its surface was not, and Phase 4.2's reminder engine had nothing to remind
-- anybody about (DEV-039). The route is what needs these columns; the table did not.
--
-- WHY AN IDEMPOTENCY KEY
-- The same reason 0016 and 0017 exist, with a sharper edge. A person who taps Save on a schedule,
-- sees nothing and taps again would otherwise get two schedules on one medicine - and a reminder
-- engine reads every active schedule for an item, so the visible symptom is not a duplicate row on
-- a list. It is being reminded twice, at the same minute, to take the same tablet. Spec 18 forbids
-- shaming copy precisely because people act on what a medicine app tells them, and being told
-- twice is how somebody takes two.
--
-- WHY IT IS SCOPED TO THE ITEM
-- DEC-079's reasoning again. Under a global unique index a key another user already used makes
-- this INSERT fail, and the replay SELECT then runs under row-level security, finds nothing, and
-- answers success with no ID - dropping the schedule silently. `(owned_item_id,
-- client_operation_id)` is a scope the caller can always read back, because `schedule_select`
-- admits exactly the rows whose `owned_item` they can see, which is what `schedule_insert` already
-- required of them to write it.
--
-- WHY A VERSION
-- 13's conflict policy is per entity type and a schedule is user-owned durable state, so an edit
-- is conditional on the version the editor was looking at - the same rule `owned_item` follows.
-- Two carers editing the same medicine's times must not have one silently overwrite the other:
-- when a reminder fires is not a field where last-write-wins is a harmless default.

ALTER TABLE medicine_schedule
  -- Client-generated, nullable, and NULL for every row this build has ever created - there are
  -- none. The column records that one write path was asked to commit exactly once.
  ADD COLUMN client_operation_id uuid,
  -- Starts at 1 so a client that has read a row always has a version to send back, and a row that
  -- has never been edited is distinguishable from one that has.
  ADD COLUMN version integer NOT NULL DEFAULT 1;

ALTER TABLE medicine_schedule
  ADD CONSTRAINT schedule_version_positive CHECK (version >= 1);

-- Partial, so it indexes only the rows that have a key and so the predicate says out loud that an
-- absent key is not a key every row shares.
CREATE UNIQUE INDEX medicine_schedule_idempotency
  ON medicine_schedule (owned_item_id, client_operation_id)
  WHERE client_operation_id IS NOT NULL;

COMMENT ON COLUMN medicine_schedule.client_operation_id IS
  'Idempotency key for schedule creation (spec 13). Unique per owned item, not globally: a global '
  'key lets one household''s key refuse another''s write, whose replay read then returns nothing '
  'under RLS and drops the schedule silently. A duplicate schedule is a duplicate reminder.';

COMMENT ON COLUMN medicine_schedule.version IS
  'Optimistic concurrency for edits (spec 13, per-entity conflict policy). A schedule is user-owned '
  'durable state, so an update is conditional on the version the editor read - when a reminder '
  'fires is not a field where last-write-wins is harmless.';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- 0004's policies are not enough, and building the write path is what made that visible.
--
-- `schedule_insert` and `schedule_update` require only that the caller can *see* the owned item:
--   WITH CHECK (EXISTS (SELECT 1 FROM owned_item i WHERE i.id = owned_item_id))
-- The subquery runs under `owned_item_select`, so the whole condition reduces to VIEW_MEDICINES.
-- That was harmless while nothing wrote a row. With a route, it means **a caregiver granted
-- read-only access to somebody's medicines can create and edit their reminder schedule** - decide
-- when they are told to take a tablet, or deactivate the schedule so they are never told at all.
-- 08.2 requires a caregiver's capabilities to be separately scoped, and every sibling table gets
-- this right already: `dose_event` is a record of something that happened and is reachability-
-- scoped on purpose, but `review_task` writes need MANAGE_CARE and `allergy` writes need
-- MANAGE_MEDICINES. A schedule is the same kind of thing as those, not the same kind as a dose
-- event.
--
-- WHY THE ITEM MUST BE A MEDICINE
-- The capability that governs a personal-care item is MANAGE_SHELF, so a policy naming only
-- MANAGE_MEDICINES over any item kind would check the wrong capability for a shampoo. Rather than
-- branch, the write path says what the table's name has always said: a schedule belongs to a
-- medicine. No row anywhere in this build is affected - the table is empty, because until this
-- migration nothing could write one.
--
-- WHY SELECT IS LEFT ALONE
-- Reading a schedule needs the item to be readable and nothing more, which is what 0004 already
-- says. A caregiver who can see a medicine may see when it is taken; the asymmetry between
-- reading and writing is the point of a capability model.
--
-- A caller holding MANAGE_MEDICINES but not VIEW_MEDICINES cannot write either, because the
-- EXISTS subquery reads `owned_item` under its own SELECT policy. That is the same property
-- `owned_item_update` has and it is the safe direction to be wrong in: it refuses a write, it
-- does not admit one.

DROP POLICY schedule_insert ON medicine_schedule;
CREATE POLICY schedule_insert ON medicine_schedule
  FOR INSERT TO kynviora_app
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM owned_item i
       WHERE i.id = owned_item_id
         AND i.item_kind = 'MEDICINE'
         AND kynviora.has_capability(i.profile_id, 'MANAGE_MEDICINES')
    )
  );

DROP POLICY schedule_update ON medicine_schedule;
CREATE POLICY schedule_update ON medicine_schedule
  FOR UPDATE TO kynviora_app
  USING (
    EXISTS (
      SELECT 1 FROM owned_item i
       WHERE i.id = owned_item_id
         AND i.item_kind = 'MEDICINE'
         AND kynviora.has_capability(i.profile_id, 'MANAGE_MEDICINES')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM owned_item i
       WHERE i.id = owned_item_id
         AND i.item_kind = 'MEDICINE'
         AND kynviora.has_capability(i.profile_id, 'MANAGE_MEDICINES')
    )
  );

-- Note that 0004 grants no DELETE policy to `kynviora_app`, and this migration does not add one.
-- A schedule is deactivated rather than removed (`active`), because a dose event references the
-- schedule it was recorded against and deleting the schedule would leave a history nobody can
-- read back - the same reason DEV-032 archives an item rather than deleting it.
