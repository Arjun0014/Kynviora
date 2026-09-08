-- 0033_shelf_collection.sql
-- The shelf is two collections: what somebody has, and what they are thinking about.
--
-- Spec references: `03` (the Unified Health Shelf), `04` Phase 2.1 (the item lifecycle), `06`
-- (Shelf is a primary destination and defines every state), `02` (no ranking, no aggregate),
-- `09`/`10` (a safety statement is scoped to what it is about), DEC-151, DEC-160.
--
-- WHY THIS IS NOT A LIFECYCLE STATE
-- `lifecycle_state` answers "is this thing current for this person" - ACTIVE, STOPPED, ARCHIVED -
-- and the reminder engine, the safety sweep, the retention plan and the shelf's own attention
-- rules all read it. Adding CONSIDERING to it would change what every one of those means, silently
-- and in the same commit.
--
-- The two are orthogonal. Something being considered is a live entry on the shelf - it is ACTIVE,
-- it can be looked up, its ingredients can be read - and what differs is that nobody is using it.
-- So it is its own column, and every existing row is `IN_USE`, which is true rather than
-- convenient: there is no route in this build that could have created an item meaning anything
-- else.
--
-- WHY IT IS WORTH A COLUMN AT ALL RATHER THAN A CLIENT-SIDE FILTER
-- Because a safety statement about something somebody is considering is a **different statement**
-- from one about something they use, and this build cannot currently make the distinction. V3's
-- own copy makes it - *"Declared in Oralux Enamel Care and Nera Scalp Balance, both in Considering.
-- Not declared in the 8 items in use"* - and a sentence like that is not composable from a filter
-- a client applied after the fact.
--
-- WHY ONLY A PERSONAL-CARE ITEM MAY BE CONSIDERED
-- This is the constraint that makes the concept safe rather than merely labelled, and it is not an
-- invention: in V3's own design every product in Considering is personal care and every medicine is
-- on the shelf.
--
-- The reason it matters is that everything this app does with a medicine presumes it is being
-- taken. `medicine_schedule` fires reminders; `dose_event` is an append-only record of what
-- happened; adherence is read off both. A medicine in Considering would either carry reminders to
-- take a medicine nobody has started, or need every one of those paths taught a new exception -
-- and the failure mode of getting that wrong is somebody taking a tablet because their phone told
-- them to.
--
-- Expressed as a CHECK on this table rather than as a rule in a route, because it is then true of
-- the data. It is also table-local by construction: both tables that would have to be consulted
-- are already medicine-scoped (`0004` and `0020` refuse a schedule or a dose on a personal-care
-- item), so forbidding a medicine in Considering forecloses the whole class without a trigger and
-- without a cross-table subquery on every insert.
--
-- What this deliberately does not model is "a medicine I might ask about". That is a real thing and
-- it is a different feature with its own safety story - not this column widened.

ALTER TABLE owned_item
  ADD COLUMN shelf_collection text NOT NULL DEFAULT 'IN_USE';

ALTER TABLE owned_item
  ADD CONSTRAINT owned_item_shelf_collection_valid
    CHECK (shelf_collection IN ('IN_USE', 'CONSIDERING'));

ALTER TABLE owned_item
  ADD CONSTRAINT owned_item_considering_is_personal_care
    CHECK (shelf_collection = 'IN_USE' OR item_kind = 'PERSONAL_CARE');

-- The shelf reads one profile's items in one collection. `owned_item_profile_idx` is keyed on
-- (profile_id, lifecycle_state) and still serves the unfiltered read; this serves the filtered one
-- without making either scan the other's rows.
CREATE INDEX owned_item_collection_idx ON owned_item (profile_id, shelf_collection)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN owned_item.shelf_collection IS
  'Whether this is something the person has (IN_USE) or is evaluating (CONSIDERING). Orthogonal '
  'to lifecycle_state, which says whether the record is current. Only a personal-care item may be '
  'CONSIDERING: see 0033 for why.';
