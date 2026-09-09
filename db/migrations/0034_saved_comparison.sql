-- 0034_saved_comparison.sql
-- A comparison somebody kept, frozen at the moment they read it.
--
-- Spec references: `09` (a source fact and a Kynviora conclusion are different things; a
-- limitation travels with the fact it qualifies), `02` (no score, no ranking), `13` (a profile ID
-- narrows a result set and never grants access), `14` (least privilege), `16` (retention),
-- `23` D-014, `docs/RETENTION.md`, DEC-097, DEC-162, DEC-163.
--
-- WHY A SAVED COMPARISON IS FROZEN AND NOT RE-COMPUTED
-- V3 asks for "saved comparisons", and the whole question in that phrase is what one *is* once the
-- products underneath it have changed. Two answers, and only one of them is a record:
--
--   Re-computed. Opening a saved comparison re-reads the labels and draws today's answer. Then it
--   is a bookmark rather than a report, and the sentence "I compared these in March and chose that
--   one" has nothing behind it - the screen that justified the choice no longer exists.
--
--   Frozen. It says what the labels said when somebody read them, and it is stamped. Then it is a
--   record of a reading, which is what `09` means by keeping a source fact as the fact it was.
--
-- Frozen, and the same shape DEC-097 chose for `assessment_matched_inputs`: freeze the **finding**,
-- not the rendering. What is stored is terms, cells, counts and the identifiers and display names
-- the person actually saw - never a composed label like "Product not verified", which is wording
-- this build may improve and which would then be stale inside a stored row.
--
-- The display name **is** frozen, and that is deliberate rather than an oversight of the rule
-- above. A product renamed afterwards does not change what was on the screen, and a report that
-- silently adopted the new name would be describing a comparison nobody made.
--
-- WHY THERE IS NO EXPIRY AND NO PURGE CATEGORY OF ITS OWN
-- `docs/RETENTION.md` gives every artefact either a lifetime or an owner whose deletion takes it.
-- A saved comparison has no natural lifetime: it is a record somebody chose to keep, like a note.
-- What it does have is a subject, and the conservative rule is the one this migration takes - it
-- is deleted when **any** of the products it is about is deleted, because a report describing a
-- product somebody asked to be forgotten is that product surviving in a different table.
--
-- That is why the link table exists at all rather than the identifiers living only in the frozen
-- body: the retention sweep has to be able to join.

CREATE TABLE saved_comparison (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id         uuid NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
  -- Who took it. `14`: a saved report is a thing a person made, and an access history that could
  -- not say who made one would be describing an event with no actor.
  taken_by_user_id   uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  -- What the person called it, or NULL. Optional because naming a thing is a step, and `18` does
  -- not make somebody title a report before they may keep it.
  title              text,
  -- When the reading happened. Distinct from `created_at` on purpose: they are the same instant
  -- today and would not be if a saved comparison were ever composed from an earlier read.
  taken_at           timestamptz NOT NULL DEFAULT now(),
  -- The finding, frozen. Never a rendering - see the module note.
  report             jsonb NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,

  CONSTRAINT saved_comparison_title_not_blank
    CHECK (title IS NULL OR length(btrim(title)) > 0),
  -- An object, not an array and not a scalar. A body of the wrong shape is one no reader can
  -- render, and this is the last place it can be refused rather than crash a screen.
  CONSTRAINT saved_comparison_report_is_object
    CHECK (jsonb_typeof(report) = 'object')
);

CREATE INDEX saved_comparison_profile_idx ON saved_comparison (profile_id, taken_at DESC)
  WHERE deleted_at IS NULL;

CREATE TRIGGER saved_comparison_touch BEFORE UPDATE ON saved_comparison
  FOR EACH ROW EXECUTE FUNCTION kynviora.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Which products a saved comparison is about
-- ---------------------------------------------------------------------------
-- The subject, as rows the retention sweep can join against. The frozen body carries these
-- identifiers too; this table is what makes them queryable, and the two cannot disagree because
-- the route writes both in one statement.

CREATE TABLE saved_comparison_item (
  comparison_id  uuid NOT NULL REFERENCES saved_comparison (id) ON DELETE CASCADE,
  owned_item_id  uuid NOT NULL REFERENCES owned_item (id) ON DELETE CASCADE,
  -- Which column it was. The order of a comparison is the order somebody chose (`02` forbids this
  -- layer re-ordering it), so it is stored rather than derived from anything.
  position       integer NOT NULL,

  PRIMARY KEY (comparison_id, owned_item_id),
  CONSTRAINT saved_comparison_item_position_valid CHECK (position BETWEEN 0 AND 3)
);

CREATE INDEX saved_comparison_item_item_idx ON saved_comparison_item (owned_item_id);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- A saved comparison is shelf content: it holds product names and ingredient terms. So it is read
-- by whoever may read the shelf, and written by whoever may read it - taking a report is not a
-- change to anybody's record.
--
-- It is **not** gated on `MANAGE_SHELF`. Reading and keeping what you read are the same act, and
-- requiring the capability that can delete somebody's products in order to keep a note about them
-- would be the `DEV-049` shape: a write capability standing in for a read one.

ALTER TABLE saved_comparison ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_comparison FORCE ROW LEVEL SECURITY;
ALTER TABLE saved_comparison_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_comparison_item FORCE ROW LEVEL SECURITY;

-- Scoped to the two application roles rather than left at PUBLIC, which the rest of the schema can
-- afford and this pair cannot. A policy with no `TO` applies to every role, so the sweep would
-- evaluate this one **as well as** its own - and this one reads `saved_comparison_item`, whose
-- policy reads `saved_comparison`, which Postgres reports as `infinite recursion detected in policy`.
-- Two tables that reference each other in their policies have to say which role each policy is for.
CREATE POLICY saved_comparison_select ON saved_comparison FOR SELECT
  TO kynviora_app, kynviora_service
  USING (deleted_at IS NULL AND kynviora.has_capability(profile_id, 'VIEW_SHELF'));

CREATE POLICY saved_comparison_insert ON saved_comparison FOR INSERT
  TO kynviora_app, kynviora_service
  WITH CHECK (
    kynviora.has_capability(profile_id, 'VIEW_SHELF')
    -- The actor is the caller. A row claiming somebody else took it would make the history a
    -- record of who the writer said acted rather than of who did.
    AND taken_by_user_id = kynviora.current_user_id()
  );

-- Removing one is an update to `deleted_at`, not a DELETE: `16` treats a person's own artefact as
-- theirs to remove, and the sweep is what actually removes rows.
CREATE POLICY saved_comparison_update ON saved_comparison FOR UPDATE
  TO kynviora_app, kynviora_service
  USING (kynviora.has_capability(profile_id, 'VIEW_SHELF'))
  WITH CHECK (kynviora.has_capability(profile_id, 'VIEW_SHELF'));

CREATE POLICY saved_comparison_item_select ON saved_comparison_item FOR SELECT
  TO kynviora_app, kynviora_service
  USING (
    EXISTS (
      SELECT 1 FROM saved_comparison c
       WHERE c.id = comparison_id
         AND c.deleted_at IS NULL
         AND kynviora.has_capability(c.profile_id, 'VIEW_SHELF')
    )
  );

CREATE POLICY saved_comparison_item_insert ON saved_comparison_item FOR INSERT
  TO kynviora_app, kynviora_service
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM saved_comparison c
       WHERE c.id = comparison_id AND kynviora.has_capability(c.profile_id, 'VIEW_SHELF')
    )
  );

GRANT SELECT, INSERT, UPDATE ON saved_comparison, saved_comparison_item TO kynviora_app;
GRANT SELECT, INSERT, UPDATE ON saved_comparison, saved_comparison_item TO kynviora_service;

-- ---------------------------------------------------------------------------
-- The sweep
-- ---------------------------------------------------------------------------
-- `kynviora_retention` cannot call `has_capability` - `0022` gives it no grant on it, deliberately,
-- because the sweep is not a person and must not be able to ask what one may see. So it gets its
-- own policies, mirroring `0023` and `0032`: the role sees only rows that are **already** due, and
-- cannot read a live report even to count it.
--
-- Due means "a product this report is about is due", which is `item_is_due_for_purge` over the link
-- table. A saved comparison has no deadline of its own; it inherits its subjects' (see the module
-- note).

GRANT SELECT, DELETE ON saved_comparison, saved_comparison_item TO kynviora_retention;

CREATE POLICY saved_comparison_purge ON saved_comparison
  FOR SELECT TO kynviora_retention
  USING (
    EXISTS (
      SELECT 1 FROM saved_comparison_item i
       WHERE i.comparison_id = id AND kynviora.item_is_due_for_purge(i.owned_item_id)
    )
  );
CREATE POLICY saved_comparison_purge_delete ON saved_comparison
  FOR DELETE TO kynviora_retention
  USING (
    EXISTS (
      SELECT 1 FROM saved_comparison_item i
       WHERE i.comparison_id = id AND kynviora.item_is_due_for_purge(i.owned_item_id)
    )
  );

CREATE POLICY saved_comparison_item_purge ON saved_comparison_item
  FOR SELECT TO kynviora_retention USING (kynviora.item_is_due_for_purge(owned_item_id));
CREATE POLICY saved_comparison_item_purge_delete ON saved_comparison_item
  FOR DELETE TO kynviora_retention USING (kynviora.item_is_due_for_purge(owned_item_id));
