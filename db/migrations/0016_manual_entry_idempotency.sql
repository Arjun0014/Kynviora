-- 0016_manual_entry_idempotency.sql
-- A retried "save" writes one item, not two (spec 13, spec 04 Phases 2.2 and 2.3).
--
-- Spec references: 13 ("idempotency key on mutations that can be retried"; "server commits exactly
-- once"), 04 Phase 2.2, 04 Phase 8.5 (reconciliation reads this shelf), 02.
--
-- WHY THIS ARRIVES ONE MIGRATION AFTER THE ROUTE
-- 0015 gave POST /v1/items its columns, and until there was a screen there was no retry: every
-- caller was a test that submits once. A person on a train tapping "Save", seeing nothing, and
-- tapping again is the retry, and without a key it writes a second medicine record. That is worse
-- than a duplicate row on a list. Spec 04 Phase 8.5 reconciles the shelf against a list somebody
-- was handed, and two identical rows there read as two medicines a person is taking - which is a
-- false statement about somebody's treatment, produced by a dropped connection.
--
-- WHY THE KEY IS SCOPED TO THE PROFILE, WHERE dose_event's IS GLOBAL
-- 0004 made dose_event.client_operation_id globally unique. Under that shape, a key another
-- household already used makes this INSERT fail, and the replay SELECT then runs under row-level
-- security and returns nothing - so the second household's item is silently dropped and answered
-- with a success carrying no ID. Scoping the uniqueness to the profile makes that unreachable:
-- collisions can only happen inside a scope the caller can actually read back, which is the only
-- scope where a replay is a real replay. dose_event is left as it is; changing the shape of a
-- shipped idempotency guarantee is not a thing to do in passing (DEV-031).

ALTER TABLE owned_item
  -- Client-generated, nullable, and NULL for every row this build already created. Seeded items,
  -- sync-created items and the fixtures carry no key and need none - the column records that one
  -- specific write path was asked to commit exactly once, not that every row has an origin.
  ADD COLUMN client_operation_id uuid;

-- The idempotency guarantee. Partial so it indexes only the rows that have a key, and so the
-- predicate states out loud that an absent key is not a key everybody shares.
CREATE UNIQUE INDEX owned_item_idempotency
  ON owned_item (profile_id, client_operation_id)
  WHERE client_operation_id IS NOT NULL;

COMMENT ON COLUMN owned_item.client_operation_id IS
  'Idempotency key for manual entry (spec 13). Unique per profile, not globally: a global key '
  'lets one household''s key refuse another household''s write, whose replay read then returns '
  'nothing under RLS and drops the item silently.';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- Nothing to add, for 0015's reason: this is a column on owned_item and 0004's policies already
-- decide who may read and write it. The replay read is the caller's own SELECT through
-- owned_item_select, so a key belonging to a profile the caller cannot reach finds no row - which
-- is the same not-found the route gives for the profile itself, and not an oracle for either.
