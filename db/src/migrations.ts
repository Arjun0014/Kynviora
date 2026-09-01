/**
 * Migration loading and the database role names.
 *
 * Extracted from the test harness so the runtime can use them without importing a file called
 * "harness". The harness re-exports these, so every existing test import keeps working.
 *
 * Nothing here touches a database or an environment: it reads files and hashes them, which is why
 * both the in-memory test harness and the persisted runtime can share it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const MIGRATIONS_DIR = join(HERE, '..', 'migrations');

/**
 * The workspace root: two levels above this file, which lives at `db/src`.
 *
 * Needed because the local database directory must not depend on which package's script started
 * the process. `npm run dev` runs with `services/api` as its working directory and `npm run
 * migrate` runs with `db`, so a relative `KYNVIORA_LOCAL_DB_DIR` produced two different databases
 * for what a developer would reasonably assume was one. PGlite is a single writer, so the second
 * one is not a shared copy - it is a separate, empty database that looks like data loss.
 */
export const WORKSPACE_ROOT = join(HERE, '..', '..');

/** Default local database directory, anchored at the workspace root rather than at the cwd. */
export const DEFAULT_DATA_DIR = join(WORKSPACE_ROOT, '.kynviora-data');

/**
 * Resolve a configured data directory.
 *
 * An absolute path is honoured as given; a relative one is resolved against the workspace root,
 * so the same value in `.env` means the same directory whichever script reads it.
 */
export function resolveDataDir(configured: string | undefined): string {
  if (configured === undefined || configured.trim() === '') return DEFAULT_DATA_DIR;
  return isAbsolute(configured) ? configured : join(WORKSPACE_ROOT, configured);
}

/** Database roles used by the application (see `0001_foundation.sql`). */
export const APP_ROLE = 'kynviora_app';
export const SERVICE_ROLE = 'kynviora_service';

export interface Migration {
  readonly version: string;
  readonly sql: string;
  readonly checksum: string;
}

/** Read migrations in lexical order. Filenames are zero-padded so this is also numeric order. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(dir, file), 'utf8');
      return {
        version: file.replace(/\.sql$/, ''),
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    });
}
