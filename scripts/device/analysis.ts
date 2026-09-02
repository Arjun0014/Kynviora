/**
 * What a device's own files have to show before "encrypted local storage" may be claimed.
 *
 * Spec references: `14` ("Mobile security validation ... Test at minimum: local data storage;
 * cryptography/key management", and "encrypted local storage validated" as a release gate), `12`
 * (encrypted structured local store, key in Keystore, backup behaviour reviewed), `19` (device
 * E2E), OWASP MASVS-STORAGE / MASTG. `BLK-002`.
 *
 * WHY THE JUDGEMENTS LIVE HERE AND THE DEVICE WORK DOES NOT
 * `verifyLocalStorage.ts` runs `adb`; this file decides what its output means. Split that way,
 * every rule below is exercised by `analysis.test.ts` on a machine with no emulator attached - so
 * the checks are covered by `npm run verify` and only the evidence needs hardware.
 *
 * WHY THERE IS AN INCONCLUSIVE RESULT
 * A file that could not be read is not a pass. The most dangerous shape for a security check is
 * one that reports success when it could not look, and a two-valued result forces exactly that
 * whenever the tooling fails. {@link overallStatus} refuses to call a run successful with an
 * inconclusive check in it.
 */

/**
 * The first sixteen bytes of every unencrypted SQLite database.
 *
 * Fifteen characters and a NUL, written as an escape: a literal NUL in a source file is a byte
 * most tools silently mangle, and a magic value that got mangled would stop matching without
 * anything failing.
 */
export const SQLITE_PLAINTEXT_HEADER = 'SQLite format 3\u0000';

export type CheckStatus = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export interface Check {
  /** Stable identifier, so a result can be cited in a document. */
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  /** What was actually observed. Never a restatement of the title. */
  readonly detail: string;
}

/**
 * Whether a file begins with SQLite's plaintext magic.
 *
 * SQLCipher encrypts the header along with everything else, so a database that still announces
 * itself is a database with no key applied - which is exactly what a `PRAGMA key` issued after
 * the first read produces, and what is invisible from reading the code.
 */
export function looksLikePlaintextSqlite(bytes: Uint8Array): boolean {
  const magic = new TextEncoder().encode(SQLITE_PLAINTEXT_HEADER);
  if (bytes.length < magic.length) return false;
  for (let index = 0; index < magic.length; index += 1) {
    if (bytes[index] !== magic[index]) return false;
  }
  return true;
}

/**
 * Whether a byte sequence contains a string.
 *
 * Deliberately a raw byte scan rather than decode-then-search: decoding a binary file as UTF-8
 * replaces invalid sequences, and a replacement character landing inside the needle would hide a
 * match. Ciphertext is invalid UTF-8 almost everywhere, so that is the normal case, not an edge.
 */
export function containsBytesOf(haystack: Uint8Array, needle: string): boolean {
  const target = new TextEncoder().encode(needle);
  if (target.length === 0 || haystack.length < target.length) return false;

  for (let start = 0; start <= haystack.length - target.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < target.length; offset += 1) {
      if (haystack[start + offset] !== target[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * Whether a string looks like the database key this app generates.
 *
 * `secureDatabase.ts` stores a 256-bit key as 64 lowercase hex characters and refuses to open the
 * database with anything else, so that is the shape a leak would take. The test is on the shape
 * rather than on a captured value, because the point is to search for any such string - including
 * one from an install whose key nobody recorded.
 */
export function looksLikeDatabaseKey(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/** Every 64-character lowercase hex run in a text file, which is what a leaked key would be. */
export function hexKeyCandidatesIn(text: string): readonly string[] {
  return text.match(/[0-9a-f]{64}/g) ?? [];
}

// ---------------------------------------------------------------------------
// Local storage
// ---------------------------------------------------------------------------

export interface DatabaseEvidence {
  /** The bytes of the database pulled off the device, or `null` where it could not be read. */
  readonly bytes: Uint8Array | null;
  /** Where it was read from, for the report. */
  readonly path: string;
  /**
   * Strings known to be in the database's logical content.
   *
   * Taken from data the app actually stored, never invented: a canary the harness wrote itself
   * would only show that the harness's own write was encrypted.
   */
  readonly knownContent: readonly string[];
}

export function checkDatabaseIsEncrypted(evidence: DatabaseEvidence): readonly Check[] {
  const bytes = evidence.bytes;
  if (bytes === null) {
    return [
      {
        id: 'STORAGE-1',
        title: 'The local database exists and could be read for inspection',
        status: 'INCONCLUSIVE',
        detail:
          `Nothing could be read from ${evidence.path}. ` +
          'Encryption at rest is unproven, which is not the same as disproven.',
      },
    ];
  }

  const plaintextHeader = looksLikePlaintextSqlite(bytes);
  const checks: Check[] = [
    {
      id: 'STORAGE-1',
      title: 'The local database exists and could be read for inspection',
      status: 'PASS',
      detail: `Read ${String(bytes.length)} bytes from ${evidence.path}.`,
    },
    {
      id: 'STORAGE-2',
      title: 'The database does not announce itself as plaintext SQLite',
      status: plaintextHeader ? 'FAIL' : 'PASS',
      detail: plaintextHeader
        ? 'The file begins with "SQLite format 3", so no key was applied to it.'
        : "The first sixteen bytes are not SQLite's magic, which SQLCipher also encrypts.",
    },
  ];

  if (evidence.knownContent.length === 0) {
    checks.push({
      id: 'STORAGE-3',
      title: 'Content the app stored is not readable in the raw file',
      status: 'INCONCLUSIVE',
      detail:
        'No known stored content was supplied, so the file was not scanned. A header check on ' +
        'its own does not show that the pages are encrypted.',
    });
    return checks;
  }

  const leaked = evidence.knownContent.filter((value) => containsBytesOf(bytes, value));
  checks.push({
    id: 'STORAGE-3',
    title: 'Content the app stored is not readable in the raw file',
    status: leaked.length === 0 ? 'PASS' : 'FAIL',
    detail:
      leaked.length === 0
        ? `Scanned the file for ${String(evidence.knownContent.length)} string(s) the app had ` +
          'stored through its ordinary write path; none appears.'
        : `Found in plaintext: ${leaked.join(', ')}.`,
  });
  return checks;
}

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

export interface KeyStoreEvidence {
  /** The app's own key-value files, as text, keyed by the path they came from. */
  readonly files: ReadonlyMap<string, string>;
  /** Whether the app reopened the database after being killed, or `null` if not exercised. */
  readonly reopenedAfterProcessDeath: boolean | null;
}

export function checkKeyHandling(evidence: KeyStoreEvidence): readonly Check[] {
  const leaks: string[] = [];
  for (const [path, text] of evidence.files) {
    for (const candidate of hexKeyCandidatesIn(text)) {
      if (looksLikeDatabaseKey(candidate)) leaks.push(path);
    }
  }
  const searched = evidence.files.size;

  const checks: Check[] = [
    {
      id: 'KEY-1',
      title: "The database key is not in the app's own files in plaintext",
      status: searched === 0 ? 'INCONCLUSIVE' : leaks.length === 0 ? 'PASS' : 'FAIL',
      detail:
        searched === 0
          ? 'No key-value files were read, so nothing was searched.'
          : leaks.length === 0
            ? `Searched ${String(searched)} file(s) for a 256-bit hex key; none contains one.`
            : `A value shaped like the database key appears in: ${[...new Set(leaks)].join(', ')}.`,
    },
    {
      id: 'KEY-2',
      title: 'The key survives process death and still opens the database',
      status:
        evidence.reopenedAfterProcessDeath === null
          ? 'INCONCLUSIVE'
          : evidence.reopenedAfterProcessDeath
            ? 'PASS'
            : 'FAIL',
      detail:
        evidence.reopenedAfterProcessDeath === null
          ? 'The app was not killed and relaunched, so key persistence was not exercised.'
          : evidence.reopenedAfterProcessDeath
            ? 'After a force-stop the app reopened the database and read back what it had stored.'
            : 'After a force-stop the app could not read back what it had stored.',
    },
  ];

  return checks;
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/**
 * Whether the installed package still allows platform backup.
 *
 * The evidence is the device's own view - `dumpsys package` prints a `flags=[ ... ]` list, and
 * `ALLOW_BACKUP` appears in it exactly when backup is on. Reading the merged manifest instead
 * would show what the build intended rather than what the phone installed, and `14` asks for the
 * behaviour to be reviewed, not the source.
 *
 * The absence of the flag is the pass, so an empty or unrecognisable input has to be refused
 * rather than treated as absence - which is what the `flags=[` guard is for.
 */
export function checkBackupPolicy(packageFlags: string | null): readonly Check[] {
  const id = 'BACKUP-1';
  const title = 'Backup behaviour is set explicitly rather than left to the platform default';

  if (packageFlags === null || !packageFlags.includes('flags=[')) {
    return [
      {
        id,
        title,
        status: 'INCONCLUSIVE',
        detail:
          'No `flags=[ ... ]` line was read from the installed package, so nothing was ' +
          'inspected. An unreadable flag list is not an absent one.',
      },
    ];
  }

  // Tokenised rather than matched with a word boundary: the flag list is space-separated
  // and an exact token is what "the flag is present" means, where a substring match would
  // also fire on a longer name that happens to contain it.
  const allowed = packageFlags.split(/[^A-Z_]+/).includes('ALLOW_BACKUP');
  return [
    {
      id,
      title,
      status: allowed ? 'FAIL' : 'PASS',
      detail: allowed
        ? 'The installed package carries ALLOW_BACKUP, so the encrypted store and the keystore ' +
          'alias can be copied off the device by platform backup.'
        : 'The installed package does not carry ALLOW_BACKUP, so platform backup does not copy ' +
          'the encrypted store off the device.',
    },
  ];
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * The result of a run.
 *
 * A single `FAIL` fails it, and so does a single `INCONCLUSIVE`: "we could not check" is not a
 * result anybody may put behind a release gate.
 */
export function overallStatus(checks: readonly Check[]): CheckStatus {
  if (checks.length === 0) return 'INCONCLUSIVE';
  if (checks.some((check) => check.status === 'FAIL')) return 'FAIL';
  if (checks.some((check) => check.status === 'INCONCLUSIVE')) return 'INCONCLUSIVE';
  return 'PASS';
}

export function formatReport(checks: readonly Check[]): string {
  const lines = checks.map(
    (check) =>
      `${check.status.padEnd(12)} ${check.id.padEnd(10)} ${check.title}\n` +
      `${' '.repeat(23)}${check.detail}`,
  );
  return `${lines.join('\n')}\n\nOverall: ${overallStatus(checks)}`;
}
