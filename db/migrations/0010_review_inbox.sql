-- 0010_review_inbox.sql
-- Household Review Inbox (spec 04 Phase 8.3).
--
-- `review_task` was created in `0004` with the right vocabulary and, deliberately, no urgency and
-- no evidence level - that absence is exit criterion 1 and is preserved here. What it lacked was
-- a way to be about anything other than an owned item: two of the seven kinds are about a
-- caregiver grant and a published alert, and `owned_item_id` cannot name either.
--
-- WHAT THIS MIGRATION ADDS, AND WHY
--  * a generic subject (`subject_kind` + `subject_id`), with a CHECK tying it to the task kind,
--    so a task cannot claim to be about a record its kind is not about;
--  * `owned_item_id` kept and constrained to agree with the subject, so the existing FK still
--    cascades - deleting an item still removes its tasks with no sweep;
--  * a partial unique index over open tasks, so a re-run of derivation cannot produce a second
--    row for a condition already on the list;
--  * `completed_by_user_id` and `completion_fields`, which record *that* the authoritative record
--    changed and which fields - never the values (16 keeps content out of the log).

ALTER TABLE review_task
  ADD COLUMN subject_kind        text,
  ADD COLUMN subject_id          uuid,
  ADD COLUMN completed_by_user_id uuid REFERENCES app_user (id) ON DELETE SET NULL,
  ADD COLUMN outcome             text,
  -- Field *names* only. A corrected medicine strength is exactly the content that must not land
  -- in a durable log; knowing that `strength_text` changed answers what the record exists for.
  ADD COLUMN completion_fields   text[] NOT NULL DEFAULT ARRAY[]::text[];

-- Existing rows (there are none in any environment yet, but the migration must be total) are
-- owned-item tasks by construction, since that was the only subject the table could express.
UPDATE review_task
   SET subject_kind = 'owned_item',
       subject_id   = owned_item_id
 WHERE subject_kind IS NULL AND owned_item_id IS NOT NULL;

DELETE FROM review_task WHERE subject_kind IS NULL;

ALTER TABLE review_task
  ALTER COLUMN subject_kind SET NOT NULL,
  ALTER COLUMN subject_id   SET NOT NULL;

ALTER TABLE review_task
  ADD CONSTRAINT review_task_subject_kind_valid
    CHECK (subject_kind IN ('owned_item', 'caregiver_grant', 'alert_publication',
                            'refill_estimate')),

  -- Each kind is about exactly one sort of record. Without this a BATCH_MISSING row could name a
  -- caregiver grant, and the completion path would then be asked to write a batch number onto an
  -- authorization record.
  ADD CONSTRAINT review_task_subject_matches_kind
    CHECK (
      (task_kind IN ('ITEM_NOT_REVIEWED_RECENTLY', 'BATCH_MISSING', 'FORMULA_NEEDS_CONFIRMATION',
                     'OCR_FIELD_UNRESOLVED')
        AND subject_kind = 'owned_item')
      OR (task_kind = 'CAREGIVER_GRANT_EXPIRING' AND subject_kind = 'caregiver_grant')
      OR (task_kind = 'SAFETY_ITEM_AWAITING_CONFIRMATION' AND subject_kind = 'alert_publication')
      OR (task_kind = 'REFILL_ESTIMATE_NEEDS_REVIEW' AND subject_kind = 'refill_estimate')
    ),

  -- Keeps the existing foreign key meaningful: for an owned-item task the two columns are the
  -- same value, so the ON DELETE CASCADE from `0004` still removes tasks with their item.
  ADD CONSTRAINT review_task_owned_item_agrees
    CHECK (
      (subject_kind = 'owned_item' AND owned_item_id = subject_id)
      OR (subject_kind <> 'owned_item' AND owned_item_id IS NULL)
    ),

  ADD CONSTRAINT review_task_outcome_valid
    CHECK (outcome IS NULL OR outcome IN ('RESOLVED', 'NOT_APPLICABLE')),

  -- Exit criterion 2, at the schema level. A closed task must name who closed it, when, how, and
  -- which fields of the authoritative record changed. A row that is COMPLETED or DISMISSED with
  -- an empty `completion_fields` is unrepresentable, so "mark done" cannot be written even by a
  -- direct SQL statement that bypasses the API entirely.
  ADD CONSTRAINT review_task_closed_wrote_something
    CHECK (
      state = 'OPEN'
      OR (completed_at IS NOT NULL
          AND completed_by_user_id IS NOT NULL
          AND outcome IS NOT NULL
          AND cardinality(completion_fields) > 0)
    ),

  -- And the converse: an open task has not been closed by anyone.
  ADD CONSTRAINT review_task_open_is_unclosed
    CHECK (
      state <> 'OPEN'
      OR (completed_at IS NULL AND completed_by_user_id IS NULL AND outcome IS NULL)
    );

-- One open task per condition. Derivation is idempotent by construction rather than by the
-- generator remembering what it produced last time.
CREATE UNIQUE INDEX review_task_open_subject_idx
  ON review_task (profile_id, task_kind, subject_kind, subject_id)
  WHERE state = 'OPEN';

CREATE INDEX review_task_subject_idx ON review_task (subject_kind, subject_id);

COMMENT ON TABLE review_task IS
  'Non-urgent maintenance work (04 Phase 8.3). Carries no urgency, evidence level, severity or '
  'score: a review task is not an assessment and must not borrow the vocabulary of one.';

COMMENT ON COLUMN review_task.completion_fields IS
  'Names of the authoritative-record fields a completion changed. Never their values.';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- The SELECT policy from `0004` uses VIEW_CARE, which is right for reading the list. The UPDATE
-- policy used MANAGE_CARE, which is not: completing a task writes to the *underlying* record, and
-- the capability that admits that write belongs to the record, not to the inbox. Leaving it as it
-- was would make the inbox a side channel - someone with care access could correct a medicine, or
-- renew a caregiver grant, by going through a task instead of the surface that governs it.
--
-- The row-level policy cannot express "the capability for this task's kind" as a single predicate
-- without repeating the mapping, so it is written out per kind. The domain holds the same mapping
-- in COMPLETION_CAPABILITIES, and a test asserts the two agree.

DROP POLICY review_task_update ON review_task;

CREATE POLICY review_task_complete ON review_task
  FOR UPDATE TO kynviora_app
  USING (
    CASE task_kind
      -- The owned-item kinds admit either management capability. owned_item_update narrows by
      -- item_kind, and a task row names only the item ID, so this predicate cannot tell which
      -- applies. Naming one would disagree with the policy that actually decides the write.
      WHEN 'ITEM_NOT_REVIEWED_RECENTLY' THEN kynviora.has_capability(profile_id, 'MANAGE_SHELF')
        OR kynviora.has_capability(profile_id, 'MANAGE_MEDICINES')
      WHEN 'BATCH_MISSING' THEN kynviora.has_capability(profile_id, 'MANAGE_SHELF')
        OR kynviora.has_capability(profile_id, 'MANAGE_MEDICINES')
      WHEN 'FORMULA_NEEDS_CONFIRMATION' THEN kynviora.has_capability(profile_id, 'MANAGE_SHELF')
        OR kynviora.has_capability(profile_id, 'MANAGE_MEDICINES')
      WHEN 'OCR_FIELD_UNRESOLVED' THEN kynviora.has_capability(profile_id, 'MANAGE_SHELF')
        OR kynviora.has_capability(profile_id, 'MANAGE_MEDICINES')
      WHEN 'CAREGIVER_GRANT_EXPIRING' THEN kynviora.has_capability(profile_id, 'MANAGE_CAREGIVERS')
      WHEN 'SAFETY_ITEM_AWAITING_CONFIRMATION' THEN kynviora.has_capability(profile_id, 'VIEW_SAFETY')
      WHEN 'REFILL_ESTIMATE_NEEDS_REVIEW' THEN kynviora.has_capability(profile_id, 'MANAGE_MEDICINES')
      ELSE false
    END
  )
  WITH CHECK (
    CASE task_kind
      -- The owned-item kinds admit either management capability. owned_item_update narrows by
      -- item_kind, and a task row names only the item ID, so this predicate cannot tell which
      -- applies. Naming one would disagree with the policy that actually decides the write.
      WHEN 'ITEM_NOT_REVIEWED_RECENTLY' THEN kynviora.has_capability(profile_id, 'MANAGE_SHELF')
        OR kynviora.has_capability(profile_id, 'MANAGE_MEDICINES')
      WHEN 'BATCH_MISSING' THEN kynviora.has_capability(profile_id, 'MANAGE_SHELF')
        OR kynviora.has_capability(profile_id, 'MANAGE_MEDICINES')
      WHEN 'FORMULA_NEEDS_CONFIRMATION' THEN kynviora.has_capability(profile_id, 'MANAGE_SHELF')
        OR kynviora.has_capability(profile_id, 'MANAGE_MEDICINES')
      WHEN 'OCR_FIELD_UNRESOLVED' THEN kynviora.has_capability(profile_id, 'MANAGE_SHELF')
        OR kynviora.has_capability(profile_id, 'MANAGE_MEDICINES')
      WHEN 'CAREGIVER_GRANT_EXPIRING' THEN kynviora.has_capability(profile_id, 'MANAGE_CAREGIVERS')
      WHEN 'SAFETY_ITEM_AWAITING_CONFIRMATION' THEN kynviora.has_capability(profile_id, 'VIEW_SAFETY')
      WHEN 'REFILL_ESTIMATE_NEEDS_REVIEW' THEN kynviora.has_capability(profile_id, 'MANAGE_MEDICINES')
      ELSE false
    END
  );

-- Derivation runs server-side and writes rows about records the caller may not individually hold
-- a grant on, so it goes through the service role. A client that could insert its own tasks could
-- also manufacture a task naming a record it wants written, and the completion path trusts the
-- task's subject.
--
-- Removed at both layers, as elsewhere in this schema: dropping the policy alone would already
-- deny the insert under FORCE ROW LEVEL SECURITY, and revoking the grant means a future policy
-- added without thinking does not silently re-open the path.
DROP POLICY review_task_insert ON review_task;
REVOKE INSERT ON review_task FROM kynviora_app;
