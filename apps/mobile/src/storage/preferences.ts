/**
 * Small, non-identity-scoped device preferences.
 *
 * Spec references: `12` (one encrypted structured local store), `14` (AsyncStorage is not
 * approved for health, safety, consent or session data), `18` (appearance is an accessibility
 * setting), DEC-130.
 *
 * WHY THIS IS NOT THE PROJECTION
 * The projection is the last thing the **server** said, and it is cleared on sign-out and on an
 * identity change, deliberately. A preference is neither: nobody's shelf is in it, and somebody
 * who chose the light theme has not un-chosen it by signing out. So it is its own table, and
 * `clear()` here is a separate act nothing calls on sign-out.
 *
 * WHY IT IS STILL IN THE ENCRYPTED DATABASE
 * Not because a theme choice is sensitive - it is not. Because `12` asks for **one** local store,
 * and a second storage mechanism for one string is a second thing to open, migrate, back up and
 * reason about. It rides in the database that is already open.
 *
 * Keys are a closed union rather than free strings, so a typo is a compile error rather than a
 * setting that silently never persists.
 */

import type { SQLiteDatabase } from 'expo-sqlite';

const TABLE = 'device_preference_v1';

/** Every preference this build stores. Closed, so nothing writes a key nothing reads. */
export const PREFERENCE_KEYS = ['appearance'] as const;
export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

export interface PreferenceStore {
  /** The stored value for a key, or `null` where nobody has chosen one. */
  read(key: PreferenceKey): Promise<string | null>;
  write(key: PreferenceKey, value: string): Promise<void>;
  /** Remove one preference, returning it to whatever the default is. */
  forget(key: PreferenceKey): Promise<void>;
}

export async function openPreferencesOn(database: SQLiteDatabase): Promise<PreferenceStore> {
  await database.execAsync(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (` +
      'key TEXT PRIMARY KEY NOT NULL, ' +
      'value TEXT NOT NULL' +
      ') STRICT;',
  );

  return {
    async read(key: PreferenceKey): Promise<string | null> {
      const row = await database.getFirstAsync<{ value: string }>(
        `SELECT value FROM ${TABLE} WHERE key = ?;`,
        key,
      );
      return row?.value ?? null;
    },

    async write(key: PreferenceKey, value: string): Promise<void> {
      await database.runAsync(
        `INSERT INTO ${TABLE} (key, value) VALUES (?, ?) ` +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value;',
        key,
        value,
      );
    },

    async forget(key: PreferenceKey): Promise<void> {
      await database.runAsync(`DELETE FROM ${TABLE} WHERE key = ?;`, key);
    },
  };
}
