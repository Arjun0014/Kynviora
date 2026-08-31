-- 0008_visit_pack.sql
-- Visit Pack: a controlled, user-selected export for a professional handoff.
--
-- Spec references: 04 Phase 8.4, 06 Journey 8, 03 group I, 16 (Export: intentional user action,
-- show what will be included, re-authenticate, expire temporary export objects, audit without
-- duplicating sensitive content), 07 (VisitPack is a "generated selection/version snapshot"),
-- 13 (export generation is a privileged server-only operation).
--
-- WHAT IS STORED, AND WHAT DELIBERATELY IS NOT
-- The pack row holds the *manifest*: which records were selected, at which version, and a digest
-- of the reviewed content. It does not hold a copy of the content itself (DEC-022).
--
-- The reason is that a copy would be a second, longer-lived, less-protected store of exactly the
-- data 16 classifies as most sensitive - one that survives the user correcting or deleting the
-- original. Rendering from the live records instead means a deletion is a deletion, and there is
-- no cached export to enumerate in the deletion workflow that 16 requires.
--
-- The honest cost is that the underlying records can move on after generation. The digest is what
-- makes that visible rather than silent: a reader is told the pack no longer matches what was
-- generated, instead of being shown different data under an old date.

CREATE TABLE visit_pack (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id          uuid NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
  created_by_user_id  uuid NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,

  -- The selection and version snapshot (spec 07). An array of objects, each
  -- {section, entityKind, entityId, version}. IDs and version numbers only - no display names,
  -- no ingredient text, no notes.
  manifest            jsonb NOT NULL,

  -- Digest of the content the user reviewed and confirmed. 64 lowercase hex.
  content_digest      text NOT NULL,

  -- User-written questions travel with the pack and are genuinely part of its content, so they
  -- are stored here rather than reconstructed. They are the only free text on this table, and
  -- they were written by the user for the express purpose of being shared.
  notes               text[] NOT NULL DEFAULT ARRAY[]::text[],

  generated_at        timestamptz NOT NULL DEFAULT now(),
  -- NOT NULL: 16 requires temporary export objects to expire. A pack with no expiry would be a
  -- permanent shareable view of someone's medicines.
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoked_by_user_id  uuid REFERENCES app_user (id) ON DELETE SET NULL,

  -- Idempotency key (spec 13). A retried generate must not produce a second pack.
  client_operation_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT visit_pack_digest_shape CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  -- Both sides of this comparison must be written from the same clock. `expires_at` is derived
  -- from the injected clock, so the writer supplies `generated_at` from it too rather than
  -- letting the column default to the database wall clock. Mixing the two makes a short lifetime
  -- unsatisfiable once real time passes it - a row the domain considers valid, refused here.
  CONSTRAINT visit_pack_expiry_after_generation CHECK (expires_at > generated_at),
  -- An empty pack is not a handoff, and accepting one would mean the export path is reachable
  -- without the user having chosen anything (04 Phase 8.4: export never happens automatically).
  CONSTRAINT visit_pack_not_empty
    CHECK (jsonb_array_length(manifest) > 0 OR cardinality(notes) > 0),
  CONSTRAINT visit_pack_manifest_is_array CHECK (jsonb_typeof(manifest) = 'array'),
  CONSTRAINT visit_pack_revoked_complete
    CHECK (revoked_at IS NULL OR revoked_by_user_id IS NOT NULL)
);

CREATE INDEX visit_pack_profile_idx ON visit_pack (profile_id, generated_at DESC);

CREATE UNIQUE INDEX visit_pack_operation_idx
  ON visit_pack (client_operation_id)
  WHERE client_operation_id IS NOT NULL;

COMMENT ON COLUMN visit_pack.manifest IS
  'Selection and version snapshot: which records, at which version. Never their content '
  '(DEC-022).';

COMMENT ON COLUMN visit_pack.content_digest IS
  'Digest of the content the user reviewed. Recomputed on retrieval so a pack that no longer '
  'matches its generated content is reported as such rather than silently rendering new data.';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

ALTER TABLE visit_pack ENABLE ROW LEVEL SECURITY;
ALTER TABLE visit_pack FORCE ROW LEVEL SECURITY;

-- Read-only for the app role. Spec 13 lists export generation among the privileged server-only
-- operations, and spec 16 requires re-authentication before an export - a requirement the
-- database cannot check, so the write path must go through the service role where the API has
-- already established it.
GRANT SELECT ON visit_pack TO kynviora_app;
GRANT SELECT, INSERT, UPDATE ON visit_pack TO kynviora_service;

-- Visible to the profile owner, to the person who created it, and to a caregiver holding
-- EXPORT_SUMMARY. Spec 03 group H requires exports to be a *separate* permission from viewing
-- the shelf or the medicines, so a caregiver who can read the medicines is deliberately not
-- thereby able to see what has been exported.
CREATE POLICY visit_pack_select ON visit_pack
  FOR SELECT TO kynviora_app
  USING (
    kynviora.owns_profile(profile_id)
    OR created_by_user_id = kynviora.current_user_id()
    OR kynviora.has_capability(profile_id, 'EXPORT_SUMMARY')
  );

CREATE POLICY visit_pack_service_all ON visit_pack
  FOR ALL TO kynviora_service USING (true) WITH CHECK (true);
