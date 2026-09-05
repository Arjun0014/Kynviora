/**
 * Which database a process opens, decided in one place.
 *
 * Spec references: `21` (environments), `14` (deny by default), DEC-037, `BLK-001`.
 *
 * There are two stores now and there will be exactly two for a while: a local PGlite directory
 * that a single process owns, and a managed Postgres that several processes share. Every entry
 * point - the API, the retention worker, a script - has to make the same choice, and the failure
 * mode of making it three times is one of them quietly opening the wrong one. So it is made here.
 *
 * THE SWITCH IS THE CONNECTION STRING, AND IT WINS
 * `KYNVIORA_DATABASE_URL` set means managed. `KYNVIORA_LOCAL_DB_DIR` has a default, so it can
 * never mean "no local database" and could not be the switch even if somebody wanted it to be.
 * The result says which was chosen, because a process that silently opened an empty local
 * database when it was meant to reach production is the mistake this whole module exists to make
 * loud.
 */

import {
  createManagedRuntimeDb,
  readManagedDatabaseUrl,
  type ManagedDbOptions,
} from './managed.js';
import { createRuntimeDb, type RuntimeDb } from './runtime.js';

export type DatabaseKind = 'LOCAL_PGLITE' | 'MANAGED_POSTGRES';

export interface OpenedDb {
  readonly db: RuntimeDb;
  readonly kind: DatabaseKind;
  /**
   * Where it is, with any credential removed.
   *
   * Safe to log and meant to be: `21` wants an operator able to see which environment a process
   * attached to, and the connection string is the one thing that may never appear in a log.
   */
  readonly describedAs: string;
}

export interface OpenDbOptions {
  /** Local data directory, already resolved. `undefined` means in-memory. */
  readonly dataDir?: string | undefined;
  /** Managed connection string. `null` or absent means read it from the environment. */
  readonly connectionString?: string | null;
  /** Passed through when the managed adapter is chosen. */
  readonly managed?: Omit<ManagedDbOptions, 'connectionString'>;
}

/** Host, port and database. Never the credential. */
export function describeConnection(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.hostname}:${url.port}${url.pathname}`;
  } catch {
    return 'managed database';
  }
}

export async function openRuntimeDb(options: OpenDbOptions = {}): Promise<OpenedDb> {
  const connectionString =
    options.connectionString === undefined ? readManagedDatabaseUrl() : options.connectionString;

  if (connectionString !== null && connectionString !== '') {
    return {
      db: await createManagedRuntimeDb({ ...options.managed, connectionString }),
      kind: 'MANAGED_POSTGRES',
      describedAs: describeConnection(connectionString),
    };
  }

  return {
    db: await createRuntimeDb(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    kind: 'LOCAL_PGLITE',
    describedAs: options.dataDir ?? 'in-memory',
  };
}
