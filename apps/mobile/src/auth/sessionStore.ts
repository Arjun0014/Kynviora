/**
 * Where a signed-in session is kept between launches.
 *
 * Spec references: `14` ("AsyncStorage is **not approved** for health, safety, consent or
 * **session** data"), `12` (one encrypted structured local store; authorization loss invalidates
 * local access), DEC-012, DEC-118.
 *
 * WHY IT IS A TABLE IN THE ENCRYPTED DATABASE
 * Because `14` names session data in the same sentence as health data, and every library default
 * puts it somewhere else. `@supabase/supabase-js` writes to `AsyncStorage` unless told otherwise;
 * Expo's own examples use `SecureStore`, which is Keystore-backed and is the right shape - and is
 * also where the **database key** lives, which means a refresh token there would sit beside the
 * key protecting everything else and share its failure modes.
 *
 * So it goes behind the SQLCipher key, in the store that already holds the projection and the
 * journal. One key, one file, one thing to get right - which is the argument `localStore.ts`
 * already makes about the journal.
 *
 * WHY ONE ROW
 * A phone has one signed-in person at a time. A table that could hold two would need a rule for
 * which one is current, and the rule would be the bug: `12` requires an identity change to
 * invalidate local access, and the way to guarantee that is for there to be nowhere for the
 * previous identity to still be.
 */

import type { SQLiteDatabase } from 'expo-sqlite';
import type { AuthTokens } from '@kynviora/contracts';

/**
 * Versioned by table name, exactly as the projection and the journal are, and with the same
 * limitation recorded as `DEV-042`: a shape change starts a new table rather than migrating.
 */
const TABLE = 'auth_session_v1';

/** The single row. A phone has one signed-in person. */
const ONLY_ROW = 'current';

export interface SessionStore {
  /** The stored session, or `null` where nobody is signed in. */
  read(): Promise<AuthTokens | null>;
  /** Replace whatever is there. Called on sign-in and after every renewal. */
  write(tokens: AuthTokens): Promise<void>;
  /** Forget it. Sign-out, and every kind of authorization loss (`12`). */
  clear(): Promise<void>;
}

export async function openSessionStore(database: SQLiteDatabase): Promise<SessionStore> {
  await database.execAsync(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (` +
      'id TEXT PRIMARY KEY NOT NULL, ' +
      'access_token TEXT NOT NULL, ' +
      'refresh_token TEXT NOT NULL, ' +
      'expires_at_seconds INTEGER NOT NULL' +
      ');',
  );

  return {
    async read(): Promise<AuthTokens | null> {
      const row = await database.getFirstAsync<{
        access_token: string;
        refresh_token: string;
        expires_at_seconds: number;
      }>(`SELECT access_token, refresh_token, expires_at_seconds FROM ${TABLE} WHERE id = ?`, [
        ONLY_ROW,
      ]);
      if (row === null || row === undefined) return null;
      // A row that is missing any part of a session is not half a session - it is one that cannot
      // be renewed, which signs somebody out an hour later for no visible reason. Treated as
      // absent, which puts them on the sign-in screen now instead.
      if (row.access_token === '' || row.refresh_token === '') return null;
      return {
        accessToken: row.access_token,
        refreshToken: row.refresh_token,
        expiresAtSeconds: row.expires_at_seconds,
      };
    },

    async write(tokens: AuthTokens): Promise<void> {
      await database.runAsync(
        `INSERT INTO ${TABLE} (id, access_token, refresh_token, expires_at_seconds)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at_seconds = excluded.expires_at_seconds`,
        [ONLY_ROW, tokens.accessToken, tokens.refreshToken, tokens.expiresAtSeconds],
      );
    },

    async clear(): Promise<void> {
      await database.runAsync(`DELETE FROM ${TABLE}`);
    },
  };
}
