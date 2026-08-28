-- 0001_foundation.sql
-- Roles, schema, request-context helpers and the audit log.
--
-- Spec references: 13 (authorization), 14 (deny by default, least privilege), 15 (A1/A2),
-- 07 (AuditEvent).
--
-- AUTHORIZATION MODEL
-- Two database roles, so that authorization is defence in depth rather than a single layer:
--
--   kynviora_app     - carries ordinary authenticated user requests. Row-level security applies
--                      in full. It has NO write grant on shared catalog or regulatory tables, so
--                      even a SQL-injection flaw on a user request path cannot rewrite shared
--                      truth (spec 03 group K: "shared catalog publication is server-authoritative
--                      and protected from direct user writes").
--   kynviora_service - privileged server/worker operations: publication, ingestion, grant
--                      finalisation, audit writes. Uses separate credentials.
--
-- Neither role is a superuser. Superusers bypass RLS entirely even under FORCE ROW LEVEL
-- SECURITY, which is why the test harness asserts it is not connected as one before making any
-- authorization assertion (DEC-005).

-- Roles are created only when absent so migrations stay idempotent across environments where
-- roles may be provisioned by the platform (e.g. a managed Postgres).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kynviora_app') THEN
    CREATE ROLE kynviora_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kynviora_service') THEN
    CREATE ROLE kynviora_service NOLOGIN;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS kynviora;
GRANT USAGE ON SCHEMA kynviora TO kynviora_app, kynviora_service;

-- Public schema access is granted per-table by later migrations. Nothing is reachable by
-- default; a table with no explicit GRANT is unreachable by the app role, which is the correct
-- deny-by-default posture.
GRANT USAGE ON SCHEMA public TO kynviora_app, kynviora_service;

-- ---------------------------------------------------------------------------
-- Request context
-- ---------------------------------------------------------------------------
-- The API sets these GUCs per request/transaction via set_config(). They are the only channel
-- through which policies learn who is acting. `true` on current_setting means "return NULL if
-- unset" rather than raising, so an unset context yields NULL and every policy comparison
-- evaluates to NULL - which fails closed.

CREATE OR REPLACE FUNCTION kynviora.current_user_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('kynviora.user_id', true), '')::uuid;
$$;

-- Marks a session as performing a privileged operation. Checked *in addition to* the database
-- role, never instead of it, so setting the GUC alone grants nothing.
CREATE OR REPLACE FUNCTION kynviora.is_service() RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT pg_has_role(current_user, 'kynviora_service', 'MEMBER');
$$;

COMMENT ON FUNCTION kynviora.current_user_id() IS
  'Authenticated user for the current request. NULL when unset, so policies fail closed.';

-- ---------------------------------------------------------------------------
-- Shared conveniences
-- ---------------------------------------------------------------------------

-- Every durable entity uses a non-guessable ID (spec 07). gen_random_uuid() is v4 from pgcrypto,
-- built into Postgres 13+.
CREATE OR REPLACE FUNCTION kynviora.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- Blocks UPDATE and DELETE on append-only tables (DEC-013). Assertion values, audit events and
-- published safety records must remain retrievable so a past assessment can be replayed exactly
-- (spec 09). Enforced by the database, not only by application code.
CREATE OR REPLACE FUNCTION kynviora.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Table % is append-only; use supersession instead of % (see DEC-013).',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

-- ---------------------------------------------------------------------------
-- Audit log (spec 07 AuditEvent, 14 reviewer/admin security, 20 audit vs observability)
-- ---------------------------------------------------------------------------
-- Append-only. Spec 20: "Audit logs answer 'who performed a sensitive action and what version
-- changed?'" and explicitly must not become verbose copies of health content, so this table
-- stores actors, targets and versions - never medicine names, diagnoses or alert text.

CREATE TABLE audit_event (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_user_id   uuid,
  actor_role      text NOT NULL,
  action          text NOT NULL,
  target_kind     text NOT NULL,
  target_id       uuid,
  target_version  text,
  correlation_id  text,
  -- Constrained to non-sensitive scalars by convention and reviewed in code review; the column
  -- exists for version identifiers and machine codes, not free text (spec 14 logging policy).
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT audit_action_not_blank CHECK (length(btrim(action)) > 0),
  CONSTRAINT audit_target_kind_not_blank CHECK (length(btrim(target_kind)) > 0)
);

CREATE INDEX audit_event_occurred_idx ON audit_event (occurred_at DESC);
CREATE INDEX audit_event_actor_idx ON audit_event (actor_user_id, occurred_at DESC);
CREATE INDEX audit_event_target_idx ON audit_event (target_kind, target_id, occurred_at DESC);

CREATE TRIGGER audit_event_append_only
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION kynviora.forbid_mutation();

ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_event FORCE ROW LEVEL SECURITY;

-- Only privileged server operations write audit events (spec 13 "Privileged server-only
-- operations"). The app role gets no grant at all here, so ordinary user requests cannot write
-- or read the audit log directly.
GRANT SELECT, INSERT ON audit_event TO kynviora_service;

CREATE POLICY audit_service_insert ON audit_event
  FOR INSERT TO kynviora_service
  WITH CHECK (true);

CREATE POLICY audit_service_select ON audit_event
  FOR SELECT TO kynviora_service
  USING (true);

-- ---------------------------------------------------------------------------
-- Migration bookkeeping
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_migration (
  version     text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  checksum    text NOT NULL
);
