# Provisioning a managed Postgres

What has to exist before `npm run migrate` can point at a managed database, and why each part of
it is the way it is. `managed-roles.sql` is the script; this is the reasoning and the order.

The shape is **four roles and two credentials**:

| Role                 | Logs in | Holds                                                                 |
| -------------------- | ------- | --------------------------------------------------------------------- |
| `kynviora_app`       | no      | Ordinary user requests. RLS applies in full.                          |
| `kynviora_service`   | no      | Privileged server operations. No `DELETE` on personal data (DEC-117). |
| `kynviora_retention` | no      | The purge sweep, bounded by deadline policies (`0022`, `0023`).       |
| `kynviora_migrate`   | **yes** | DDL. Owns every object. Used by one command.                          |
| `kynviora_runtime`   | **yes** | Nothing. `NOINHERIT` member of the first three.                       |

## 1. Generate two passwords, and send neither

Postgres accepts a pre-computed SCRAM-SHA-256 verifier wherever it accepts a password, so the
plaintext never has to leave the machine that will use it:

```
SCRAM-SHA-256$<iterations>:<base64 salt>$<base64 StoredKey>:<base64 ServerKey>

SaltedPassword = PBKDF2-HMAC-SHA256(password, salt, iterations, 32)
ClientKey      = HMAC-SHA256(SaltedPassword, "Client Key")
StoredKey      = SHA256(ClientKey)
ServerKey      = HMAC-SHA256(SaltedPassword, "Server Key")
```

Write the two connection strings into a file the repository ignores (`.env.*` is gitignored;
`.env.example` is the only exception).

## 2. Run `managed-roles.sql`

As a role that may create roles. It is idempotent.

## 3. Migrate

```bash
KYNVIORA_MIGRATE_DATABASE_URL=... npm run migrate
```

Thirty migrations, applied by `kynviora_migrate`, which becomes the owner of everything they
create. **This ordering is a security property, not a convenience.** A managed platform ships
default privileges keyed to the creating role: on Supabase, every table `postgres` creates in
`public` grants all privileges to `anon`, `authenticated` and `service_role`, and PostgREST
serves `public` to anyone holding the project's publishable key. Migrating with the platform's own
credential would publish fifty-seven health tables to the anonymous key - refused by
deny-by-default RLS, but published.

## 4. Point the runtime at it

```bash
KYNVIORA_DATABASE_URL=postgresql://kynviora_runtime...:5432/postgres
```

**A session-scoped port.** Identity is a session GUC and privilege is a session role, so a
transaction-mode pooler discards both between statements. The adapter proves the pool is
session-scoped at startup and re-checks the effective role on every checkout, so the failure is
closed - but the configuration is still wrong, and on Supabase the right port is 5432 rather
than 6543.

## 5. Verify it

```bash
npx vitest run --project server db/managedParity.test.ts
```

The suite skips entirely without `KYNVIORA_DATABASE_URL`. With it, it asserts the schema, the RLS
posture, the privilege boundaries between the three roles, the platform's own roles reaching
nothing, and the pooling properties that only exist once connections are reused.

## What is deliberately not here

No cleanup path. `db/managedParity.test.ts` writes a fixture and does not remove it, because
nothing reachable from the runtime credential can: `kynviora_service` holds no `DELETE` on
personal data at all, and the retention policies admit only rows past a thirty-day deadline. A
`BYPASSRLS` role for tests, a temporary `NO FORCE`, or the platform's own credential would each
work and would each weaken the boundary the suite exists to prove. The fixture is idempotent
instead.
