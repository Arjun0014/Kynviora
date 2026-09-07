/**
 * The rule DEC-146 states, asserted directly.
 *
 * `DEV-081` was found by a review rather than by a test, and the fix at the time was local to the
 * Speech Gate. These are the tests for the general form: a frozen table still answers to every
 * name on `Object.prototype`, and every one of those names is a string somebody outside this
 * repository can send.
 */

import { describe, it, expect } from 'vitest';
import { ownEntry, isOwnKey } from './lookup.js';

/**
 * The names that defeat a `??` fallback.
 *
 * Not an arbitrary list: it is what `Object.prototype` carries, which is precisely the set of keys
 * for which `table[key] ?? fallback` returns something other than the fallback while the table
 * contains nothing of the kind.
 */
const INHERITED = [
  'toString',
  'constructor',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__proto__',
] as const;

const TABLE: Readonly<Record<string, string>> = Object.freeze({
  KNOWN: 'the sentence somebody wrote',
});

describe('ownEntry', () => {
  it('returns what the table carries', () => {
    expect(ownEntry(TABLE, 'KNOWN')).toBe('the sentence somebody wrote');
  });

  it('returns null for a name the table does not carry', () => {
    expect(ownEntry(TABLE, 'UNKNOWN')).toBeNull();
  });

  it.each(INHERITED)('returns null for the inherited name %s', (name) => {
    expect(ownEntry(TABLE, name)).toBeNull();
  });

  /**
   * The control, and the reason the tests above are worth having.
   *
   * A plain index answers these names with a function. Asserting that here means the tests above
   * are measuring the fix rather than restating what JavaScript already does - if a future engine
   * made `TABLE['toString']` undefined, this would fail and say so.
   */
  it('a plain index really does resolve them, which is what this exists to stop', () => {
    const naive = (key: string): unknown => TABLE[key] ?? null;
    for (const name of INHERITED) {
      expect(naive(name)).not.toBeNull();
    }
    expect(String(naive('toString'))).toContain('native code');
  });

  it('is not fooled by a table whose own value is undefined', () => {
    const sparse: Readonly<Record<string, string | undefined>> = Object.freeze({ A: undefined });
    expect(ownEntry(sparse, 'A')).toBeNull();
  });
});

describe('isOwnKey', () => {
  it('answers for a name the table carries', () => {
    expect(isOwnKey(TABLE, 'KNOWN')).toBe(true);
  });

  it.each(INHERITED)('refuses the inherited name %s', (name) => {
    expect(isOwnKey(TABLE, name)).toBe(false);
  });
});
