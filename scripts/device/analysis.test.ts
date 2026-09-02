import { describe, it, expect } from 'vitest';
import {
  SQLITE_PLAINTEXT_HEADER,
  checkBackupPolicy,
  checkDatabaseIsEncrypted,
  checkKeyHandling,
  containsBytesOf,
  formatReport,
  hexKeyCandidatesIn,
  looksLikeDatabaseKey,
  looksLikePlaintextSqlite,
  overallStatus,
  type Check,
} from './analysis.js';

const encoder = new TextEncoder();

function fileStartingWith(prefix: string, then = 'rest of the file'): Uint8Array {
  return encoder.encode(prefix + then);
}

/** Sixty-four lowercase hex characters, the shape `secureDatabase.ts` generates. */
const KEY = 'a'.repeat(8) + '0123456789abcdef'.repeat(3) + 'b'.repeat(8);

describe('the plaintext SQLite header', () => {
  it('is fifteen characters and a NUL', () => {
    // The NUL is part of the magic. A constant that lost it in an editor would still look right
    // and would match files that are not SQLite at all.
    expect(SQLITE_PLAINTEXT_HEADER).toHaveLength(16);
    expect(SQLITE_PLAINTEXT_HEADER.charCodeAt(15)).toBe(0);
  });

  it('is recognised at the start of an unencrypted database', () => {
    expect(looksLikePlaintextSqlite(fileStartingWith(SQLITE_PLAINTEXT_HEADER))).toBe(true);
  });

  it('is not recognised in ciphertext', () => {
    expect(looksLikePlaintextSqlite(encoder.encode('ÿØnot a database at all'))).toBe(false);
  });

  it('is not recognised in a file too short to hold it', () => {
    expect(looksLikePlaintextSqlite(encoder.encode('SQLite'))).toBe(false);
  });

  it('is not recognised where the magic appears later in the file', () => {
    // The header check is about byte zero. A file that merely mentions the string somewhere is a
    // different finding, and calling it plaintext would be a false alarm on an encrypted file.
    expect(looksLikePlaintextSqlite(fileStartingWith('xx', SQLITE_PLAINTEXT_HEADER))).toBe(false);
  });
});

describe('scanning a file for content the app stored', () => {
  it('finds a string that is really there', () => {
    expect(containsBytesOf(encoder.encode('..Synthetic Tablet A..'), 'Synthetic Tablet A')).toBe(
      true,
    );
  });

  it('does not find one that is not', () => {
    expect(containsBytesOf(encoder.encode('ciphertext'), 'Synthetic Tablet A')).toBe(false);
  });

  it('finds a match at the very end of the file', () => {
    // An off-by-one in the loop bound is the way this check silently stops working, and the last
    // possible position is where it would show.
    expect(containsBytesOf(encoder.encode('abcXYZ'), 'XYZ')).toBe(true);
  });

  it('is not fooled by bytes that are not valid UTF-8', () => {
    // A decode-then-search would replace the invalid byte and could split or hide the needle.
    // Ciphertext is invalid UTF-8 almost everywhere, so this is the ordinary case.
    const bytes = new Uint8Array([0xff, 0xfe, ...encoder.encode('Synthetic Tablet A'), 0x80]);
    expect(containsBytesOf(bytes, 'Synthetic Tablet A')).toBe(true);
  });

  it('never matches an empty needle', () => {
    // Otherwise every file would "contain" it and STORAGE-3 would fail on an encrypted database.
    expect(containsBytesOf(encoder.encode('anything'), '')).toBe(false);
  });
});

describe('recognising the database key', () => {
  it('accepts the shape the app generates', () => {
    expect(looksLikeDatabaseKey(KEY)).toBe(true);
  });

  it('rejects anything shorter, longer or uppercase', () => {
    expect(looksLikeDatabaseKey(KEY.slice(1))).toBe(false);
    expect(looksLikeDatabaseKey(`${KEY}0`)).toBe(false);
    expect(looksLikeDatabaseKey(KEY.toUpperCase())).toBe(false);
  });

  it('finds one embedded in a preferences file', () => {
    const xml = `<map><string name="kynviora.db.key.v1">${KEY}</string></map>`;
    expect(hexKeyCandidatesIn(xml)).toContain(KEY);
  });

  it('finds nothing in a file of encrypted values', () => {
    expect(hexKeyCandidatesIn('<map><string name="x">Zm9vYmFy==</string></map>')).toHaveLength(0);
  });
});

describe('the local storage checks', () => {
  const path = '/data/data/com.kynviora.app/files/SQLite/kynviora.db';

  it('are inconclusive rather than passing when the file could not be read', () => {
    // The check that matters most. A harness that reports success because it could not look is
    // worse than no harness, because somebody puts it behind a release gate.
    const checks = checkDatabaseIsEncrypted({ bytes: null, path, knownContent: ['x'] });
    expect(overallStatus(checks)).toBe('INCONCLUSIVE');
  });

  it('fail an unencrypted database even when the content search finds nothing', () => {
    const checks = checkDatabaseIsEncrypted({
      bytes: fileStartingWith(SQLITE_PLAINTEXT_HEADER),
      path,
      knownContent: ['Synthetic Tablet A'],
    });
    expect(overallStatus(checks)).toBe('FAIL');
    expect(checks.find((check) => check.id === 'STORAGE-2')?.status).toBe('FAIL');
  });

  it('fail a file whose header is encrypted but whose pages are not', () => {
    // Both halves are needed. A header check alone passes a file that stored the medicine name
    // in the clear a few hundred bytes later.
    const bytes = new Uint8Array([
      ...encoder.encode('ÿnot the magic..'),
      ...encoder.encode('Synthetic Tablet A'),
    ]);
    const checks = checkDatabaseIsEncrypted({
      bytes,
      path,
      knownContent: ['Synthetic Tablet A'],
    });
    expect(checks.find((check) => check.id === 'STORAGE-2')?.status).toBe('PASS');
    expect(checks.find((check) => check.id === 'STORAGE-3')?.status).toBe('FAIL');
    expect(overallStatus(checks)).toBe('FAIL');
  });

  it('are inconclusive when no stored content was named to search for', () => {
    const checks = checkDatabaseIsEncrypted({
      bytes: encoder.encode('ÿciphertext'),
      path,
      knownContent: [],
    });
    expect(overallStatus(checks)).toBe('INCONCLUSIVE');
  });

  it('pass an encrypted database whose stored content is nowhere in the bytes', () => {
    const checks = checkDatabaseIsEncrypted({
      bytes: encoder.encode('ÿØopaque bytes with nothing readable in them'),
      path,
      knownContent: ['Synthetic Tablet A', 'Development profile'],
    });
    expect(overallStatus(checks)).toBe('PASS');
  });
});

describe('the key handling checks', () => {
  it('fail when the key is sitting in a preferences file', () => {
    const checks = checkKeyHandling({
      files: new Map([['shared_prefs/SecureStore.xml', `<string>${KEY}</string>`]]),
      reopenedAfterProcessDeath: true,
    });
    expect(checks.find((check) => check.id === 'KEY-1')?.status).toBe('FAIL');
  });

  it('pass when the stored values are opaque', () => {
    const checks = checkKeyHandling({
      files: new Map([['shared_prefs/SecureStore.xml', '<string>Zm9vYmFy==</string>']]),
      reopenedAfterProcessDeath: true,
    });
    expect(overallStatus(checks)).toBe('PASS');
  });

  it('are inconclusive when no file was read and when the app was never killed', () => {
    const checks = checkKeyHandling({ files: new Map(), reopenedAfterProcessDeath: null });
    expect(checks.every((check) => check.status === 'INCONCLUSIVE')).toBe(true);
  });

  it('fail when the app cannot read back what it stored after a force-stop', () => {
    // `12` puts the key in the keystore so it outlives the process. A key that does not is a
    // medicine list that empties itself the first time Android reclaims the app.
    const checks = checkKeyHandling({
      files: new Map([['shared_prefs/SecureStore.xml', 'opaque']]),
      reopenedAfterProcessDeath: false,
    });
    expect(checks.find((check) => check.id === 'KEY-2')?.status).toBe('FAIL');
  });
});

describe('the backup check', () => {
  it('passes when the installed package does not carry ALLOW_BACKUP', () => {
    expect(checkBackupPolicy('  flags=[ DEBUGGABLE HAS_CODE ]')[0]?.status).toBe('PASS');
  });

  it('fails when it does', () => {
    // The platform default is to back the app up. The flag being present is the phone saying so.
    expect(checkBackupPolicy('  flags=[ ALLOW_BACKUP HAS_CODE ]')[0]?.status).toBe('FAIL');
  });

  it('is inconclusive when nothing could be read', () => {
    expect(checkBackupPolicy(null)[0]?.status).toBe('INCONCLUSIVE');
  });

  it('is inconclusive rather than passing on output that is not a flag list', () => {
    // The pass is the *absence* of a word, which is exactly the shape that reads as success when
    // the command failed and returned nothing.
    expect(checkBackupPolicy('')[0]?.status).toBe('INCONCLUSIVE');
    expect(checkBackupPolicy('Error: device offline')[0]?.status).toBe('INCONCLUSIVE');
  });
});

describe('the overall status', () => {
  const pass: Check = { id: 'A', title: 'a', status: 'PASS', detail: 'd' };
  const fail: Check = { id: 'B', title: 'b', status: 'FAIL', detail: 'd' };
  const unknown: Check = { id: 'C', title: 'c', status: 'INCONCLUSIVE', detail: 'd' };

  it('is inconclusive when nothing ran', () => {
    // An empty run is the shape a broken harness takes, and it must not read as success.
    expect(overallStatus([])).toBe('INCONCLUSIVE');
  });

  it('lets one failure decide', () => {
    expect(overallStatus([pass, fail, unknown])).toBe('FAIL');
  });

  it('lets one inconclusive check decide over any number of passes', () => {
    expect(overallStatus([pass, pass, unknown])).toBe('INCONCLUSIVE');
  });

  it('is a pass only when every check is one', () => {
    expect(overallStatus([pass, pass])).toBe('PASS');
  });

  it('is reported with the overall result at the end', () => {
    const report = formatReport([pass, fail]);
    expect(report).toContain('Overall: FAIL');
    expect(report).toContain('A');
    expect(report).toContain('B');
  });
});
