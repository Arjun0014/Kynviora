-- 0027_retention_health.sql
-- Making the retention run history readable by the people who would act on it (DEC-121, `20`).
--
-- Spec references: `20` (observability: a job's health is an operational metric; audit is not
-- observability; operator output carries no content), `14` (least privilege), `0026`.
--
-- WHAT `0026` LEFT
-- Run history that nothing could read. `retention_run` and `retention_run_category` are granted to
-- `kynviora_retention` alone, and that role is `NOLOGIN` and is used by exactly one process. So a
-- sweep that had not run for a week, or a category failing every night, was recorded perfectly and
-- visible to nobody - which is observability in the same sense that a black box nobody recovers is
-- a flight recorder.
--
-- WHY A FUNCTION AND NOT A GRANT
-- The obvious fix is `GRANT SELECT ON retention_run TO kynviora_service`, and it is wider than the
-- question being asked. The operations surface needs five numbers; a table grant would let every
-- service operation in the system read every run row, forever, because a grant with one consumer
-- is still a grant.
--
-- `SECURITY DEFINER` answers the question without either: the caller learns five aggregates and
-- gains no way to read a row. This is the same reasoning `0023` gives for
-- `kynviora.evidence_is_unattached`, and it applies for the same reason - the answer is small and
-- the table it comes from is not.
--
-- WHAT THESE FIVE ARE, AND WHY THEY ARE THESE FIVE
-- `20` reports what is true and stops; thresholds go beside the numbers when somebody with the
-- authority to set them has done so (`BLK-008`). So none of these is a status, a severity or a
-- judgement. Each is either absolute or **self-clearing** - it returns to a healthy value on its
-- own when the thing it describes is fixed - which is what makes them alertable without a window
-- somebody would have had to invent.
--
--   never_swept             A full sweep has never completed. Its own signal rather than an
--                           extreme value of the age below, because "never" and "just now" are
--                           the two ends of that number and an age of zero is what both would
--                           report. `sources_never_successfully_checked` exists for the same
--                           reason and this follows it.
--   last_successful_run_at  When a run last ended SUCCEEDED. **Not** PARTIAL: a sweep that
--                           skipped a category did not keep that category's deadline, and an
--                           operator asking "when did retention last work" is asking about all of
--                           it.
--   categories_failing      How many categories' **most recent** attempt failed. The actionable
--                           one, and the reason PARTIAL does not need a window: it is non-zero
--                           exactly while some promise in docs/RETENTION.md is not being kept, and
--                           it falls back to zero by itself the next time that category succeeds.
--   runs_unfinished         Runs opened and never closed. Normally zero, briefly one. Persistently
--                           above zero is a worker dying mid-sweep, which nothing else here shows.
--   rows_purged_last_run    What the most recent closed run removed. The only volume signal, and
--                           the one that distinguishes "sweeping" from "sweeping nothing".

CREATE OR REPLACE FUNCTION kynviora.retention_health()
RETURNS TABLE (
  last_successful_run_at timestamptz,
  categories_failing     integer,
  runs_unfinished        integer,
  rows_purged_last_run   integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT
    (SELECT max(started_at) FROM retention_run WHERE outcome = 'SUCCEEDED'),

    -- One row per category, the newest attempt of each, counted where it failed. `DISTINCT ON`
    -- rather than a correlated subquery so a category that has never been attempted contributes
    -- nothing rather than contributing a null nobody handles.
    (SELECT count(*)::integer FROM (
       SELECT DISTINCT ON (c.category) c.outcome
         FROM retention_run_category c
         JOIN retention_run r ON r.id = c.run_id
        ORDER BY c.category, r.started_at DESC, c.id DESC
     ) latest WHERE latest.outcome = 'FAILED'),

    (SELECT count(*)::integer FROM retention_run WHERE finished_at IS NULL),

    -- The most recently **started** closed run, not the most recently finished: two runs cannot
    -- overlap (the lease), so they agree - and if they ever disagreed, the one that started last
    -- is the one an operator means by "the last run".
    coalesce((SELECT rows_purged FROM retention_run
               WHERE finished_at IS NOT NULL
               ORDER BY started_at DESC, id DESC LIMIT 1), 0);
$$;

COMMENT ON FUNCTION kynviora.retention_health() IS
  'Five aggregates over the retention run history, for the operations snapshot (DEC-121, spec 20). '
  'SECURITY DEFINER so the caller learns the numbers without gaining a read on the rows. Carries '
  'no status and no threshold: BLK-008 records that none is approved.';

-- The service role, because `gatherOperationalCounts` runs privileged - the snapshot spans every
-- profile and every source, so the reviewer check on the route is the boundary rather than RLS.
-- Nobody else, and PUBLIC least of all: a SECURITY DEFINER function inherits the definer's rights,
-- so leaving it executable by PUBLIC is how one of these becomes a way around a policy.
REVOKE ALL ON FUNCTION kynviora.retention_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kynviora.retention_health() TO kynviora_service;
