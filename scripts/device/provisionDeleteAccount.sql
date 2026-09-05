-- Recreate the synthetic account that `npm run verify:device:delete` deletes (`DEV-062`).
--
-- Spec references: `16`, `14`, `BLK-010`, DEC-125.
--
-- WHY THIS FILE EXISTS
-- The scenario deletes the account it signs in as, at the provider, for real. So it cannot run
-- twice without something putting the account back, and that something cannot be the app: signing
-- up needs a confirmation email, and confirming one needs a mailbox this environment does not
-- have. The account is therefore created **and confirmed by an operator**, which is exactly what
-- `BLK-010` says about the other synthetic account and is said again here so nobody reads a green
-- deletion run as evidence about sign-up.
--
-- WHAT IT IS NOT
-- Not a way to make accounts. It writes one fixed synthetic address, is guarded against writing a
-- second, and touches nothing else. Run it against `kynviora-dev` only.
--
-- WHY THE EMPTY STRINGS
-- GoTrue scans these columns into non-nullable Go strings. A row created with them NULL is
-- accepted by Postgres and then answers every sign-in with `500 unexpected_failure: Database error
-- querying schema`, which reads exactly like the provider being down. Found the hard way.
--
--   psql "$KYNVIORA_SUPABASE_ADMIN_URL" -f scripts/device/provisionDeleteAccount.sql
--
-- or paste it into the SQL editor for the project. It needs rights on the `auth` schema, which
-- none of Kynviora's own three roles has - deliberately, and asserted by the parity suite.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select
  '00000000-0000-0000-0000-000000000000',
  gen_random_uuid(),
  'authenticated',
  'authenticated',
  'kynviora-delete-001@kynviora.test',
  crypt('a-long-enough-synthetic-password', gen_salt('bf')),
  now(),
  '', '', '', '', '', '', '', '',
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
where not exists (
  select 1 from auth.users where email = 'kynviora-delete-001@kynviora.test'
);

-- The identity row a password account needs. Without it the account exists and cannot sign in.
insert into auth.identities (
  id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
)
select
  gen_random_uuid(),
  u.id,
  jsonb_build_object(
    'sub', u.id::text, 'email', u.email, 'email_verified', true, 'phone_verified', false
  ),
  'email',
  u.id::text,
  now(), now(), now()
from auth.users u
where u.email = 'kynviora-delete-001@kynviora.test'
  and not exists (select 1 from auth.identities i where i.user_id = u.id);

select id, email, email_confirmed_at is not null as confirmed
from auth.users
where email = 'kynviora-delete-001@kynviora.test';
