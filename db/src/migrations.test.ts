import { describe, it, expect } from 'vitest';
import { isAbsolute, join } from 'node:path';
import { DEFAULT_DATA_DIR, WORKSPACE_ROOT, resolveDataDir } from './migrations.js';

/**
 * Where the local database lives.
 *
 * `npm run dev` runs with `services/api` as its working directory and `npm run migrate` runs with
 * `db`, so a relative `KYNVIORA_LOCAL_DB_DIR` produced two different databases for what a
 * developer would reasonably assume was one. PGlite is a single writer, so the second is not a
 * shared copy - it is a separate empty database, and opening it looks exactly like data loss.
 */
describe('the data directory does not depend on which script started the process', () => {
  it('defaults to one absolute directory at the workspace root', () => {
    expect(isAbsolute(DEFAULT_DATA_DIR)).toBe(true);
    expect(DEFAULT_DATA_DIR).toBe(join(WORKSPACE_ROOT, '.kynviora-data'));
  });

  it('resolves the same relative value to the same directory whatever the cwd', () => {
    // The property that was broken: this is what `npm run dev` and `npm run migrate` each read.
    expect(resolveDataDir('.kynviora-data')).toBe(DEFAULT_DATA_DIR);
    expect(resolveDataDir('my-db')).toBe(join(WORKSPACE_ROOT, 'my-db'));
  });

  it('honours an absolute path as given', () => {
    const absolute = join(WORKSPACE_ROOT, 'somewhere', 'else');
    expect(resolveDataDir(absolute)).toBe(absolute);
  });

  it('treats an unset or blank value as the default', () => {
    expect(resolveDataDir(undefined)).toBe(DEFAULT_DATA_DIR);
    expect(resolveDataDir('   ')).toBe(DEFAULT_DATA_DIR);
  });
});
