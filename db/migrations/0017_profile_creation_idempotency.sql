-- 0017_profile_creation_idempotency.sql
-- A retried "create" makes one household and one profile, not two (spec 13, spec 04 Phase 1.2).
--
-- Spec references: 13 ("idempotency key on mutations that can be retried"; "server commits exactly
-- once"), 04 Phase 1.2, 07, 16.
--
-- WHY THIS ARRIVES FIFTEEN MIGRATIONS AFTER THE TABLES
-- 0002 created household and profile and every caller since has been a test or a seed, each of
-- which creates once. Phase 1.2 gives a person a screen, and a person on a train taps "Create",
-- sees nothing, and taps again. Without a key that makes a second household - and a second
-- household is not a duplicate row on a list. Every later record hangs off a profile, so the two
-- copies each collect their own items, their own caregivers and their own safety history, and
-- nothing in this build merges them. The screen has no undo for it either: household deletion is
-- unbuilt for DEV-032's reason.
--
-- WHY EACH KEY IS SCOPED, NOT GLOBAL
-- DEC-079's reasoning, twice. Under a global unique index a key some other user already used makes
-- this INSERT fail, and the replay SELECT then runs under row-level security and returns nothing -
-- so the row is silently dropped and the caller is answered with a success carrying no ID. Each
-- scope below is one the caller can always read back:
--
--   household  -> (owner_user_id, client_operation_id).  household_select admits the owner.
--   profile    -> (household_id, client_operation_id).   profile_insert already requires that the
--                                                        caller owns the household, and
--                                                        profile_select admits its owner.
--
-- dose_event is still globally unique and is left alone (DEV-031).

ALTER TABLE household
  -- Client-generated, nullable, and NULL for every row this build already created. Seeded and
  -- fixture households carry no key and need none: the column records that one write path was
  -- asked to commit exactly once, not that every row has an origin.
  ADD COLUMN client_operation_id uuid;

ALTER TABLE profile
  ADD COLUMN client_operation_id uuid;

-- Partial, so they index only the rows that have a key and so the predicate states out loud that
-- an absent key is not a key every row shares.
CREATE UNIQUE INDEX household_idempotency
  ON household (owner_user_id, client_operation_id)
  WHERE client_operation_id IS NOT NULL;

CREATE UNIQUE INDEX profile_idempotency
  ON profile (household_id, client_operation_id)
  WHERE client_operation_id IS NOT NULL;

COMMENT ON COLUMN household.client_operation_id IS
  'Idempotency key for household creation (spec 13). Unique per owner, not globally: a global key '
  'lets one user''s key refuse another user''s write, whose replay read then returns nothing under '
  'RLS and drops the household silently.';

COMMENT ON COLUMN profile.client_operation_id IS
  'Idempotency key for profile creation (spec 13). Unique per household, which is the narrowest '
  'scope the caller is guaranteed to be able to read back - profile_insert already requires that '
  'they own the household.';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- Nothing to add. These are columns on two tables whose 0002 policies already decide who may read
-- and write them, and the replay read is the caller's own SELECT through household_select and
-- profile_select. A key belonging to a household the caller cannot reach finds no row, which is
-- the same not-found the route gives for the household itself and not an oracle for either.
