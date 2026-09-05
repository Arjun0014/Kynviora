-- 0026_retention_worker.sql
-- Giving the purge sweep a clock, a lock and a memory (DEC-121, `DEV-063`, `docs/RETENTION.md`).
--
-- Spec references: `16` (retention deadlines are deadlines, not intentions), `14` (least
-- privilege; the retention role gains no reach into personal data), `20` (a job reports what it
-- did, with correlation, and without copying content into the report), `0022`, `0023`.
--
-- WHAT `0023` LEFT
-- A sweep. `runPurgeSweep` is a function, `npm run purge` calls it once, and nothing calls it on a
-- timer - so every deadline in `docs/RETENTION.md` was a commitment the code could keep and the
-- operation could not. That is the one place in this system where a promise made to a person
-- outran what the system does, and this migration is the schema half of closing it.
--
-- Three tables, none of which holds personal data, and all three exist because a recurring job
-- that cannot answer "did you run, when, and what happened" is indistinguishable from one that
-- never ran.
--
-- WHY A LEASE ROW AND NOT AN ADVISORY LOCK
-- `pg_try_advisory_lock` is the shorter answer and it is the wrong one twice over. It is
-- **session**-scoped, so it is re-entrant within a session and cannot be observed from outside
-- one - which means the guarantee it provides is untestable against a single-connection database
-- (DEC-037) and invisible to an operator asking why no sweep has run. A row can be read. A row
-- can be contended in a test by writing somebody else's holder into it. And a row expires, which
-- is what makes a worker that was killed mid-sweep recoverable without anybody logging in.
--
-- WHAT THE LEASE IS NOT
-- It is not what makes the purge safe. `0023` is: every deadline lives in a policy attached to
-- `kynviora_retention`, so two workers sweeping at once would delete the same due rows twice and
-- the second would find none. The lease exists so that does not happen - so run history reads as
-- one sweep per interval rather than two halves of one - and not because overlap would destroy
-- anything. That distinction matters when reading the code: a bug in the lease wastes work; it
-- cannot widen what may be deleted.

-- ---------------------------------------------------------------------------
-- 1. The lease
-- ---------------------------------------------------------------------------
-- One row, forever. `singleton` is a primary key with a CHECK pinning it to `true`, which is the
-- cheapest way to say "there is exactly one of these" in a schema - the same shape
-- `publication_control` already uses.
--
-- `holder` is an opaque identifier a worker generates for itself at startup. It is deliberately
-- not a hostname, a user, or anything else that identifies a person or a machine: `20` keeps
-- operational rows free of content, and the only question this column has to answer is "is the
-- lease still mine".

CREATE TABLE retention_lease (
  singleton    boolean PRIMARY KEY DEFAULT true,
  holder       text,
  acquired_at  timestamptz,
  expires_at   timestamptz,

  CONSTRAINT retention_lease_singleton CHECK (singleton),
  -- Held or free, never half of either. A holder with no expiry is a lease nobody can reclaim.
  CONSTRAINT retention_lease_held_together CHECK (
    (holder IS NULL AND acquired_at IS NULL AND expires_at IS NULL)
    OR (holder IS NOT NULL AND acquired_at IS NOT NULL AND expires_at IS NOT NULL)
  ),
  CONSTRAINT retention_lease_expiry_after_acquisition CHECK (
    expires_at IS NULL OR expires_at > acquired_at
  )
);

COMMENT ON TABLE retention_lease IS
  'Overlap protection for the purge sweep (DEC-121). One row. A worker acquires it by conditional '
  'UPDATE and releases it in a finally; a worker that died holds it only until expires_at.';

INSERT INTO retention_lease (singleton) VALUES (true);

-- ---------------------------------------------------------------------------
-- 2. Run history
-- ---------------------------------------------------------------------------
-- Opened before the sweep starts and closed after it ends, rather than written once at the end.
-- A run recorded only on completion leaves a process that was killed mid-sweep looking exactly
-- like a process that was never started, and those need different answers from whoever is on
-- call.
--
-- `outcome` has four values and the third is the one this table exists for. **PARTIAL is not
-- SUCCEEDED.** A sweep in which one category raised and the rest completed has not done its job,
-- and the failure mode being guarded against is precisely a run that reports success because most
-- of it worked - which is how a table quietly stops being purged for a year.
--
-- ABANDONED is written by whichever worker next finds the row open past the lease it was covered
-- by. It is a statement about the record, not about the sweep: some categories may well have
-- completed, and their rows say so.

CREATE TABLE retention_run (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The lease holder that opened it. Correlates a run with the process that ran it (`20`) and is
  -- the same opaque value the lease carries.
  holder               text NOT NULL,
  started_at           timestamptz NOT NULL DEFAULT now(),
  finished_at          timestamptz,
  outcome              text,
  duration_ms          integer,
  -- Summaries, derived from the category rows when the run is closed rather than counted a second
  -- time in the process. Two counters incremented in different places drift; one of them then
  -- reads as a fact.
  categories_attempted integer NOT NULL DEFAULT 0,
  categories_failed    integer NOT NULL DEFAULT 0,
  rows_purged          integer NOT NULL DEFAULT 0,

  -- The three legal shapes of this row, written out rather than left to convention.
  CONSTRAINT retention_run_open_or_closed CHECK (
    (finished_at IS NULL AND outcome IS NULL AND duration_ms IS NULL)
    OR (finished_at IS NOT NULL AND outcome = 'ABANDONED' AND duration_ms IS NULL)
    OR (finished_at IS NOT NULL
        AND outcome IN ('SUCCEEDED', 'PARTIAL', 'FAILED')
        AND duration_ms IS NOT NULL)
  ),
  CONSTRAINT retention_run_duration_non_negative CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CONSTRAINT retention_run_counts_non_negative CHECK (
    categories_attempted >= 0 AND categories_failed >= 0 AND rows_purged >= 0
    AND categories_failed <= categories_attempted
  )
);

COMMENT ON COLUMN retention_run.outcome IS
  'SUCCEEDED, PARTIAL (at least one category raised and at least one did not), FAILED (every '
  'attempted category raised) or ABANDONED (the row was still open past its lease). PARTIAL is '
  'deliberately not SUCCEEDED: a sweep that skipped a table has not kept the deadline for it.';

CREATE INDEX retention_run_started_at_idx ON retention_run (started_at DESC);

-- One row per category per run. Immutable once written: there is no UPDATE or DELETE grant below,
-- so what a sweep recorded about a category is what it recorded.
--
-- WHAT A FAILURE MAY SAY, AND WHY IT IS TWO COLUMNS AND NOT A MESSAGE
-- `20` keeps health content out of operational output, and a Postgres error message is not a safe
-- place to relax that: `detail` on a constraint violation quotes the offending row's values
-- verbatim. So a failure is recorded as the **step** that raised - a label from this codebase's
-- own closed vocabulary - and the five-character SQLSTATE. Both are provably free of content, and
-- together they are enough to find the statement and the reason.

CREATE TABLE retention_run_category (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES retention_run (id) ON DELETE CASCADE,
  category          text NOT NULL,
  outcome           text NOT NULL,
  rows_purged       integer NOT NULL DEFAULT 0,
  duration_ms       integer NOT NULL,
  failure_step      text,
  failure_sqlstate  text,

  CONSTRAINT retention_run_category_once UNIQUE (run_id, category),
  CONSTRAINT retention_run_category_valid CHECK (category IN (
    'ITEM', 'PROFILE', 'VISIT_PACK_CONTENT', 'CAREGIVER_INVITATION',
    'CAPTURE_ARTIFACT', 'AUDIT_EVENT', 'CONSENT_RECEIPT'
  )),
  CONSTRAINT retention_run_category_outcome_valid CHECK (outcome IN ('SUCCEEDED', 'FAILED')),
  CONSTRAINT retention_run_category_counts CHECK (rows_purged >= 0 AND duration_ms >= 0),
  -- A failure says which step and why; a success says neither. Anything else is a row that has
  -- lost track of what it is recording.
  CONSTRAINT retention_run_category_failure_shape CHECK (
    (outcome = 'SUCCEEDED' AND failure_step IS NULL AND failure_sqlstate IS NULL)
    OR (outcome = 'FAILED' AND failure_step IS NOT NULL AND failure_sqlstate IS NOT NULL)
  ),
  -- Five characters from the SQLSTATE alphabet. A column that would accept a sentence is one an
  -- error message eventually gets written into.
  CONSTRAINT retention_run_category_sqlstate_shape CHECK (
    failure_sqlstate IS NULL OR failure_sqlstate ~ '^[0-9A-Z]{5}$'
  ),
  -- A category that failed rolled back, so it purged nothing. The count is not "what it managed
  -- before it raised"; there is no such quantity.
  CONSTRAINT retention_run_category_failed_purged_nothing CHECK (
    outcome = 'SUCCEEDED' OR rows_purged = 0
  )
);

CREATE INDEX retention_run_category_run_idx ON retention_run_category (run_id);

-- ---------------------------------------------------------------------------
-- 3. Who may touch any of this
-- ---------------------------------------------------------------------------
-- The retention role, and nobody else. `kynviora_app` and `kynviora_service` are given no grant
-- at all - not because run history is sensitive, but because deny by default is the rule and a
-- grant with no consumer is a grant nobody removes later.
--
-- Note what is **not** granted: DELETE on any of the three, and UPDATE on the category rows. The
-- role that empties tables for a living cannot edit the record of what it emptied.

ALTER TABLE retention_lease ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_lease FORCE ROW LEVEL SECURITY;
ALTER TABLE retention_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_run FORCE ROW LEVEL SECURITY;
ALTER TABLE retention_run_category ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_run_category FORCE ROW LEVEL SECURITY;

GRANT SELECT, UPDATE ON retention_lease TO kynviora_retention;
GRANT SELECT, INSERT, UPDATE ON retention_run TO kynviora_retention;
GRANT SELECT, INSERT ON retention_run_category TO kynviora_retention;

CREATE POLICY retention_lease_read ON retention_lease
  FOR SELECT TO kynviora_retention USING (true);

-- No predicate. Acquisition and release are conditional UPDATEs whose conditions are in the
-- statement, and putting either condition here would be the `DEV-057` shape again: Postgres
-- applies a policy to the new row too, so `USING (holder IS NULL)` would refuse the very statement
-- that sets a holder.
CREATE POLICY retention_lease_hold ON retention_lease
  FOR UPDATE TO kynviora_retention USING (true) WITH CHECK (true);

CREATE POLICY retention_run_read ON retention_run
  FOR SELECT TO kynviora_retention USING (true);

-- A run is opened, not created finished. A worker cannot write history for a sweep it did not
-- perform in the interval it claims to have performed it.
-- `started_at` cannot be in the future, because the schedule counts forward from it: a run row
-- dated tomorrow would push the next sweep a day out, which is the one direction this column can
-- be wrong in that costs a deadline.
CREATE POLICY retention_run_open ON retention_run
  FOR INSERT TO kynviora_retention
  WITH CHECK (
    finished_at IS NULL AND outcome IS NULL AND duration_ms IS NULL
    AND started_at <= now()
  );

-- Closing a run is the only update it accepts, and it accepts exactly one: `USING` admits only an
-- open row and `WITH CHECK` requires the result to be closed, so a completed run cannot be
-- reopened, re-outcomed or quietly recounted.
--
-- `retention_run_read` is `USING (true)` for this reason as much as for any other. A SELECT policy
-- mentioning `finished_at` would refuse this UPDATE on the new row - the defect `DEV-057` named
-- and `0023` hit a second time at `visit_pack`.
CREATE POLICY retention_run_close ON retention_run
  FOR UPDATE TO kynviora_retention
  USING (finished_at IS NULL)
  WITH CHECK (finished_at IS NOT NULL AND outcome IS NOT NULL);

CREATE POLICY retention_run_category_read ON retention_run_category
  FOR SELECT TO kynviora_retention USING (true);

CREATE POLICY retention_run_category_write ON retention_run_category
  FOR INSERT TO kynviora_retention WITH CHECK (true);
