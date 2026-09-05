/**
 * Everything the device keeps, opened once.
 *
 * Spec references: `12` (one encrypted structured local store; a read projection *and* a
 * pending-operation journal), `14`, `DEV-038`.
 *
 * WHY THIS EXISTS RATHER THAN TWO INDEPENDENT OPENERS
 * `ProjectionProvider` already says why: several connections to one SQLCipher file race each
 * other's schema creation. The projection and the journal are two tables in one database, so
 * there is one `openSecureDatabase` call and both are built on the handle it returns. A second
 * `openSecureDatabase()` for the journal would be exactly the mistake that comment warns about,
 * with the failure appearing as an intermittent "table already exists" on a cold start.
 */

import { openProjectionOn, type Projection } from './projection';
import { openSessionStore, type SessionStore } from '../auth/sessionStore';
import { openPendingOperations, type PendingOperationStore } from './pendingOperations';
import { openSecureDatabase } from './secureDatabase';

export interface LocalStore {
  /** The last thing the server said, so a screen renders with no network (`12`, `03` group J). */
  readonly projection: Projection;
  /** Edits made with no network, waiting to be sent exactly once (`12`, `13`). */
  readonly pending: PendingOperationStore;
  /**
   * The signed-in session, between launches (`14`, DEC-118).
   *
   * Here rather than in `SecureStore` or `AsyncStorage` for two reasons. `14` names session data
   * in the same sentence as health data and rules out AsyncStorage explicitly; and `SecureStore`
   * is where the **database key** lives, so a refresh token there would sit beside the key
   * protecting everything else and share its failure modes.
   */
  readonly session: SessionStore;
}

export async function openLocalStore(): Promise<LocalStore> {
  const database = await openSecureDatabase();
  const projection = await openProjectionOn(database);
  const pending = await openPendingOperations(database);
  const session = await openSessionStore(database);
  return { projection, pending, session };
}
