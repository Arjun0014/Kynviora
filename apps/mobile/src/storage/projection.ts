/**
 * The encrypted read projection.
 *
 * Spec references: `12` ("Screens read local state immediately"; server-authoritative state is
 * "synchronized into a read projection"; "Sign-out removes decrypted projections and caches";
 * "Authorization loss invalidates local access"), `03` group J (offline essentials), `14` (an
 * encrypted structured local store; never AsyncStorage for health data), DEC-012, `BLK-002`.
 *
 * WHAT THIS IS AND IS NOT
 * It is the read half: the last thing the server said, kept so the medicine list is still there
 * with no network. It is **not** the pending-operation journal `12` also describes - nothing here
 * queues a write, and a screen still cannot create an item offline. That half is `DEV-038`.
 *
 * WHY IT IS ONE TABLE OF RESPONSES RATHER THAN A SCHEMA PER ENTITY
 * Per-entity tables would be a second copy of the server's shape, maintained by hand, drifting
 * every time a response gains a field - and the drift would be silent, because nothing compares
 * them. What is stored is exactly what the client already treats as the response type, so there
 * is one shape and the server owns it. The cost is that no local query narrows a row, which is
 * fine while the projection serves whole screens.
 *
 * THERE IS NO TIMESTAMP ON A ROW
 * A `written_at` column would be read as freshness, and freshness is not what makes local content
 * safe to show - `12` decides that by whether the server answered about access, which is what
 * `projectionActionFor` encodes. How old a row is changes nothing about whether it may be
 * rendered, so storing an age would be a number somebody eventually branches on. What the screen
 * says instead is `STALE`, which is a statement about confirmation rather than about minutes.
 *
 * WHY EVERY VALUE IS SCOPED TO WHO FETCHED IT
 * The key carries the session identity (`projectionKey`, in `@kynviora/contracts`). Two people
 * using one device get
 * two sets of rows, and switching identity cannot surface the other's shelf, which is the shape
 * of leak a shared cache produces first.
 *
 * NOTHING IS CAST BLINDLY THAT WAS NOT ALREADY
 * `read` returns the parsed body as the caller's type, exactly as `http.ts` does for a live
 * response. The row was written from a response this client had already accepted as that type,
 * so the trust boundary is not moved by storing it - but it is worth saying out loud that this
 * is the same unchecked cast and not a stronger claim.
 */

import type { SQLiteDatabase } from 'expo-sqlite';
import { openSecureDatabase } from './secureDatabase';

/** Rows are versioned by table name so a shape change starts a new table rather than misreading. */
const TABLE = 'projected_read_v1';

export interface Projection {
  /** The stored body for a key, or `null` where there is none. */
  read<T>(key: string): Promise<T | null>;
  /** Replace the stored body for a key. */
  write(key: string, value: unknown): Promise<void>;
  /** Remove one key. Used when the server's answer was about access (`12`). */
  forget(key: string): Promise<void>;
  /** Remove everything. Sign-out, and identity change. */
  clear(): Promise<void>;
}

async function ensureSchema(database: SQLiteDatabase): Promise<void> {
  await database.execAsync(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (` +
      'key TEXT PRIMARY KEY NOT NULL, ' +
      'body TEXT NOT NULL' +
      ') STRICT;',
  );
}

/**
 * Open the projection over the encrypted database.
 *
 * Throws where the database cannot be opened - a missing key, a key that does not decrypt. The
 * caller renders that as "no local copy" rather than as a broken app: `12` makes offline a state,
 * and a store that will not open is the same outcome as an empty one for everything except the
 * next write, which will fail again and say so.
 */
export async function openProjection(): Promise<Projection> {
  return openProjectionOn(await openSecureDatabase());
}

/**
 * Build the projection on a database somebody else opened.
 *
 * `openLocalStore` uses this so the projection and the pending-operation journal share one
 * connection. Two `openSecureDatabase()` calls would be two connections to one SQLCipher file
 * racing each other's schema creation, which is the failure `ProjectionProvider` already warns
 * about and which shows up as an intermittent error on a cold start rather than consistently.
 */
export async function openProjectionOn(database: SQLiteDatabase): Promise<Projection> {
  await ensureSchema(database);

  return {
    async read<T>(key: string): Promise<T | null> {
      const row = await database.getFirstAsync<{ body: string }>(
        `SELECT body FROM ${TABLE} WHERE key = ?;`,
        key,
      );
      if (row === null) return null;
      try {
        return JSON.parse(row.body) as T;
      } catch {
        // A body that no longer parses is a row from a build that wrote a different shape.
        // Dropping it is right: the alternative is handing a screen something it cannot render.
        await database.runAsync(`DELETE FROM ${TABLE} WHERE key = ?;`, key);
        return null;
      }
    },

    async write(key: string, value: unknown): Promise<void> {
      await database.runAsync(
        `INSERT INTO ${TABLE} (key, body) VALUES (?, ?) ` +
          'ON CONFLICT(key) DO UPDATE SET body = excluded.body;',
        key,
        JSON.stringify(value),
      );
    },

    async forget(key: string): Promise<void> {
      await database.runAsync(`DELETE FROM ${TABLE} WHERE key = ?;`, key);
    },

    async clear(): Promise<void> {
      await database.runAsync(`DELETE FROM ${TABLE};`);
    },
  };
}
