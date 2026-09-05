-- Kynviora role provisioning for a managed Postgres (BLK-001, spec 13/14, DEC-005).
--
-- Run ONCE, as a role that may create roles, BEFORE `npm run migrate`. Everything after that is
-- the ordinary migration path.
--
-- WHY THE MIGRATION CREDENTIAL IS NOT THE PLATFORM'S OWN
-- A Supabase project ships default privileges that grant `anon`, `authenticated` and
-- `service_role` **all** privileges on every table created in `public` by `postgres` - and
-- PostgREST serves `public` to anyone holding the project's publishable key. Default privileges
-- are per-creator, so a table created by `kynviora_migrate` inherits none of them. Ownership is
-- therefore a security property here rather than a matter of taste, and
-- `db/managedParity.test.ts` asserts both halves: that every table is owned by a Kynviora role,
-- and that no PostgREST role holds any privilege on any of them.
--
-- WHY THE RUNTIME CREDENTIAL IS NOINHERIT
-- So that `SET ROLE` is a decision rather than a formality. With INHERIT the login role would
-- hold the union of app, service and retention on every connection, and a statement that forgot
-- to switch would run with all three.
--
-- PASSWORDS
-- Supply a pre-computed SCRAM-SHA-256 verifier rather than a plaintext password:
--
--   PASSWORD 'SCRAM-SHA-256$4096:<b64 salt>$<b64 StoredKey>:<b64 ServerKey>'
--
-- Postgres accepts a verifier wherever it accepts a password, so the plaintext never has to cross
-- a management channel, a shell history or a CI log. Generate it beside the connection string
-- that will use it, and put that connection string in a file the repository ignores.

DO $$
BEGIN
  -- The three roles the migrations expect. Created here so the platform, rather than migration
  -- 0001, decides how they are configured; 0001 and 0022 both guard with IF NOT EXISTS for
  -- exactly this case.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kynviora_app') THEN
    CREATE ROLE kynviora_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kynviora_service') THEN
    CREATE ROLE kynviora_service NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kynviora_retention') THEN
    CREATE ROLE kynviora_retention NOLOGIN;
  END IF;

  -- The DDL credential. Owns every Kynviora object.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kynviora_migrate') THEN
    CREATE ROLE kynviora_migrate LOGIN CREATEROLE PASSWORD :'migrate_verifier';
  END IF;

  -- The runtime credential. Holds nothing of its own.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kynviora_runtime') THEN
    CREATE ROLE kynviora_runtime LOGIN NOINHERIT PASSWORD :'runtime_verifier';
  END IF;
END
$$;

-- Enough to run the migrations, and no more. `WITH GRANT OPTION` because 0001 grants USAGE on
-- `public` onward to the app and service roles.
GRANT CREATE, USAGE ON SCHEMA public TO kynviora_migrate WITH GRANT OPTION;
GRANT CREATE ON DATABASE :"database" TO kynviora_migrate;

GRANT kynviora_app, kynviora_service, kynviora_retention TO kynviora_runtime;
GRANT kynviora_app, kynviora_service, kynviora_retention TO kynviora_migrate;

-- Neither login role may bypass row-level security, and neither is a superuser. Asserted in
-- db/managedParity.test.ts rather than trusted, because BYPASSRLS is one statement away and
-- makes every negative authorization test pass while asserting nothing.
