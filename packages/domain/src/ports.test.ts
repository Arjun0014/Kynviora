/**
 * The injected ports, and the one property each exists for.
 *
 * `07` wants identifiers nobody can guess and `09` wants an assessment that replays exactly, and
 * those two pull in opposite directions: the first needs real randomness, the second needs none at
 * all. Both generators are here so the difference between them is a decision somebody made at the
 * call site rather than an accident of what was in scope.
 */

import { describe, expect, it } from 'vitest';
import { cryptoIdGenerator, fixedClock, sequentialIdGenerator } from './ports.js';
import type { Instant } from './ports.js';

describe('cryptoIdGenerator', () => {
  it('takes its randomness from the source it was given', () => {
    // The source is a parameter for a reason a test can state: there is no one global that has
    // it. Node and a browser define `crypto`; Hermes, which is what the phone runs, does not - and
    // reading it ambiently is how `crypto.randomUUID()` reached eight screens on a device that has
    // no `crypto` at all (`DEV-043`).
    const issued = ['first', 'second'];
    const generator = cryptoIdGenerator(() => issued.shift() ?? 'exhausted');

    expect(generator.next()).toBe('first');
    expect(generator.next()).toBe('second');
  });

  it('asks for a new value every time rather than caching one', () => {
    let calls = 0;
    const generator = cryptoIdGenerator(() => {
      calls += 1;
      return `id-${String(calls)}`;
    });

    expect([generator.next(), generator.next(), generator.next()]).toEqual([
      'id-1',
      'id-2',
      'id-3',
    ]);
    expect(calls).toBe(3);
  });
});

describe('sequentialIdGenerator', () => {
  it('produces UUID-shaped values, so anything validating the format still passes', () => {
    const generator = sequentialIdGenerator();
    expect(generator.next()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('repeats exactly across runs, which is what makes a replay comparable', () => {
    const first = sequentialIdGenerator('0000000a');
    const second = sequentialIdGenerator('0000000a');
    expect([first.next(), first.next()]).toEqual([second.next(), second.next()]);
  });

  it('does not collide between generators given different prefixes', () => {
    expect(sequentialIdGenerator('0000000a').next()).not.toBe(
      sequentialIdGenerator('0000000b').next(),
    );
  });
});

describe('fixedClock', () => {
  it('stays where it was put', () => {
    const clock = fixedClock('2026-01-01T00:00:00.000Z' as Instant);
    expect(clock.now()).toBe('2026-01-01T00:00:00.000Z');
    expect(clock.now()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('moves only when it is told to', () => {
    const clock = fixedClock('2026-01-01T00:00:00.000Z' as Instant);
    clock.advanceMs(90_000);
    expect(clock.now()).toBe('2026-01-01T00:01:30.000Z');
  });
});
