-- 0030_dose_idempotency_scope.sql
-- Making a dose event's idempotency key mean what the item's already means (`DEV-031`).
--
-- Spec references: `13` ("idempotency key on mutations that can be retried"; "server commits
-- exactly once"), `14` (one household's data cannot be affected by another's), `0004`, `0016`,
-- `0021`, DEC-116.
--
-- THE DEFECT, WHICH IS A WRONG ANSWER RATHER THAN A LEAK
-- `0004` made `dose_event_idempotency` UNIQUE on `client_operation_id` **alone**, across every
-- household in the system. `0016` gave `owned_item` the right shape - unique per profile - and
-- said in writing that changing a shipped guarantee was not a thing to do in passing. This is that
-- change, done on its own.
--
-- Under a global key, a UUID another household has already used makes the INSERT conflict. The
-- route reads the failure as a retry, re-reads the row under row-level security, finds nothing
-- (the row belongs to somebody it cannot see), and answers `200` with
-- `{ id: null, replayed: true }`.
--
-- **A person is told their dose was recorded and no dose was recorded.** Nothing leaks and nothing
-- of anybody else's changes - the row suppressed is the caller's own - but it is the same class of
-- failure as `DEV-055`, where a screen said a dose was kept over a store that could not keep it,
-- and this codebase does not leave that class open on the grounds that it is hard to trigger.
--
-- WHY THE SCOPE IS THE ITEM AND NOT THE PROFILE
-- `owned_item` scopes to the profile because that is the identifier its route has. The dose route
-- has the **item**: the request names `ownedItemId`, so the replay read can be scoped to exactly
-- what the caller asked about. A retry sends the same body, so the same item, which makes the
-- narrower scope the right one - and the narrower it is, the smaller the set of writes one key can
-- refuse. `13`'s rule is satisfied either way; this satisfies it in the place the route can check.
--
-- WHAT THIS CHANGES ABOUT `id: null`
-- After this, a conflict means the same key on the **same item**, so the row is unambiguously the
-- caller's own. `{ id: null, replayed: true }` therefore stops meaning "somebody else's key blocked
-- you" and starts meaning only "already recorded, and you may not read it back" - which is a real
-- case since DEC-116 gave `RECORD_DOSES` its own capability: a caregiver may be entitled to record
-- a dose and not to read the shelf it belongs to.
--
-- NARROWING A UNIQUE INDEX CANNOT FAIL ON EXISTING ROWS
-- Worth saying, because rebuilding a unique index on a populated table usually is the risky part.
-- Every existing row satisfies the old constraint - one key, once, anywhere - and a set that is
-- globally unique is unique within every item by construction. The reverse would not be true, which
-- is why this direction is the safe one and the only one that can be done without a data audit.

DROP INDEX dose_event_idempotency;

-- No `WHERE` clause, unlike `owned_item_idempotency`. `0004` made `client_operation_id` NOT NULL
-- here, so there are no keyless rows for a partial index to exclude - the two indexes differ in
-- that one respect because the two columns do, not because the rule does.
CREATE UNIQUE INDEX dose_event_idempotency
  ON dose_event (owned_item_id, client_operation_id);

COMMENT ON COLUMN dose_event.client_operation_id IS
  'Idempotency key for dose recording (spec 13). Unique per item, not globally (DEV-031): a global '
  'key lets one household''s key refuse another household''s write, whose replay read then returns '
  'nothing under RLS and reports a dose as recorded that was never recorded.';
