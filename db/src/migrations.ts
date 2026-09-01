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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const MIGRATIONS_DIR = join(HERE, '..', 'migrations');

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
