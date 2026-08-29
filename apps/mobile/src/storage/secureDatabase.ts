/**
 * Encrypted local database (DEC-012, R-002).
 *
 * Spec references: `12` (offline storage), `14` (mobile data protection).
 *
 * `14` requires an encrypted structured local store whose key is protected by platform secure
 * hardware, and explicitly forbids AsyncStorage for health, safety, consent or session data.
 *
 * The design:
 *  - `expo-sqlite` with SQLCipher, enabled by the `useSQLCipher` plugin option in `app.json`.
 *  - A 256-bit key generated once per install by `expo-crypto`.
 *  - The key stored in `expo-secure-store`, which is Keystore-backed on Android and
 *    Keychain-backed on iOS.
 *  - `PRAGMA key` applied immediately on open, before any statement touches data.
 *
 * NOT VERIFIED IN THIS BUILD (`BLK-002`): encryption at rest has not been demonstrated on a
 * device, because no Android SDK or emulator was available. The code path is written and the
 * configuration is in place; the claim that data is encrypted on disk is unproven until a
 * development build runs and the database file is inspected.
 */

import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';

/** Key under which the database key is stored in the platform keystore. */
const DATABASE_KEY_ALIAS = 'kynviora.db.key.v1';

/** Database filename. */
const DATABASE_NAME = 'kynviora.db';

/** Key length in bytes. 32 bytes = 256 bits, SQLCipher's expected key size. */
const KEY_BYTES = 32;

/**
 * Options for the secure store entry.
 *
 * `requireAuthentication` is deliberately **not** enabled. `14` states device biometrics are "a
 * local convenience, not server identity proof", and gating the database key behind biometrics
 * would break the offline medicine list that `03` group J requires to remain available - a
 * user who cannot authenticate locally would lose access to their own current medicines.
 */
const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Get the per-install database key, generating and storing it on first use.
 *
 * The key never leaves the device and is never transmitted. It is not derived from a user
 * password, because `01` names older adults as a primary audience and a forgotten password that
 * permanently destroys the local medicine list would be a worse outcome than the threat it
 * mitigates. Device-level protection plus `WHEN_UNLOCKED_THIS_DEVICE_ONLY` is the trade-off,
 * and it is recorded here so a future reviewer can revisit it deliberately.
 */
export async function getOrCreateDatabaseKey(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DATABASE_KEY_ALIAS, SECURE_STORE_OPTIONS);
  if (existing !== null && existing.length === KEY_BYTES * 2) {
    return existing;
  }

  const generated = toHex(await Crypto.getRandomBytesAsync(KEY_BYTES));
  await SecureStore.setItemAsync(DATABASE_KEY_ALIAS, generated, SECURE_STORE_OPTIONS);
  return generated;
}

/**
 * Open the encrypted database.
 *
 * `PRAGMA key` runs before anything else. If it were issued after a read, SQLCipher would have
 * already failed to decrypt and the error would be reported as corruption rather than as a key
 * problem, which is much harder to diagnose.
 */
export async function openSecureDatabase(): Promise<SQLite.SQLiteDatabase> {
  const key = await getOrCreateDatabaseKey();
  const database = await SQLite.openDatabaseAsync(DATABASE_NAME);

  // The key is interpolated because SQLCipher's PRAGMA does not accept a bound parameter. It is
  // safe here specifically because the value is a hex string this module generated - it is never
  // user input. The assertion below enforces that invariant rather than assuming it.
  if (!/^[0-9a-f]{64}$/.test(key)) {
    throw new Error('Refusing to open the database: the stored key is not a 256-bit hex value.');
  }
  await database.execAsync(`PRAGMA key = "x'${key}'";`);

  // Verifies the key actually decrypted the file. Without this, a wrong key surfaces later as a
  // confusing corruption error partway through a user session.
  await database.execAsync('SELECT count(*) FROM sqlite_master;');

  // Foreign keys are off by default in SQLite and must be enabled per connection.
  await database.execAsync('PRAGMA foreign_keys = ON;');

  return database;
}

/**
 * Clear all local data and the database key.
 *
 * `12` and `14`: "Sign-out removes decrypted projections and cached sensitive data." Deleting
 * the key as well as the file means any residual on-disk pages remain undecryptable even if the
 * file removal is incomplete.
 */
export async function clearSecureDatabase(): Promise<void> {
  try {
    await SQLite.deleteDatabaseAsync(DATABASE_NAME);
  } finally {
    // Runs even if the delete failed, so the key is not left behind protecting recoverable data.
    await SecureStore.deleteItemAsync(DATABASE_KEY_ALIAS, SECURE_STORE_OPTIONS);
  }
}
