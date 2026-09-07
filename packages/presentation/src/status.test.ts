/**
 * DEC-146 at the one lookup on the Regulatory Lens whose key is a string off the network.
 *
 * `contracts/src/lens.ts` drops an unresolved condition by testing
 * `describeUnresolvedCondition(...) === null`. A prototype name resolved to a function, which is
 * not null, so it was **not** dropped - and the Lens rendered
 * "function toString() { [native code] }" where its own comment says even a generic sentence would
 * be too much, because it "reads as a complete answer when it is not".
 *
 * `unresolvedConditions` arrives on a `LensEntryResponse`, so the key is parsed JSON rather than
 * anything this repository chose.
 */

import { describe, it, expect } from 'vitest';
import { describeUnresolvedCondition } from './status.js';

const INHERITED = [
  'toString',
  'constructor',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__proto__',
];

describe('describeUnresolvedCondition, keyed from outside (DEC-146)', () => {
  it.each(INHERITED)('refuses the inherited name %s', (name) => {
    expect(describeUnresolvedCondition(name)).toBeNull();
  });

  it('still describes every condition it has words for', () => {
    for (const condition of ['CONCENTRATION', 'PRODUCT_USE', 'INTENDED_AGE', 'ROUTE']) {
      expect(typeof describeUnresolvedCondition(condition)).toBe('string');
    }
  });

  it('answers a genuinely unknown condition with null, as it always did', () => {
    expect(describeUnresolvedCondition('SOMETHING_A_NEWER_SERVER_SENT')).toBeNull();
  });

  it('never returns anything but a string or null', () => {
    for (const name of [...INHERITED, 'CONCENTRATION', 'nonsense']) {
      const answer = describeUnresolvedCondition(name);
      expect(answer === null || typeof answer === 'string').toBe(true);
    }
  });
});
