import { describe, it, expect } from 'vitest';
import { instantFrom } from '@kynviora/domain';
import { delayAfter, msUntilDue, type LastRetentionRun } from './schedule.js';

/**
 * When the next sweep is due.
 *
 * Spec references: `16` (retention deadlines), DEC-121.
 *
 * WHAT THESE TESTS ARE REALLY ABOUT
 * Restart durability. The schedule is computed from the last run's timestamp rather than from a
 * timer, so a worker's uptime is not part of the answer - and the way to check that is to ask the
 * same question with the same history and different "now"s, which is all this file does.
 */

const CONFIG = { intervalMs: 60_000, retryIntervalMs: 10_000 } as const;

const at = (iso: string): ReturnType<typeof instantFrom> => instantFrom(iso);

function run(startedAt: string, outcome: LastRetentionRun['outcome']): LastRetentionRun {
  return { startedAt: at(startedAt), outcome };
}

describe('how long to wait after a run', () => {
  it('is the full interval after a run that succeeded', () => {
    expect(delayAfter(run('2026-01-01T00:00:00.000Z', 'SUCCEEDED'), CONFIG)).toBe(60_000);
  });

  it.each(['PARTIAL', 'FAILED', 'ABANDONED'] as const)(
    'is the retry interval after a %s run',
    (outcome) => {
      // PARTIAL is the one worth stating out loud: some part of the matrix was not swept, so the
      // deadline for that part is already running down. Waiting a full interval would turn one
      // transient failure into a whole interval of missed deadline.
      expect(delayAfter(run('2026-01-01T00:00:00.000Z', outcome), CONFIG)).toBe(10_000);
    },
  );

  it('is the retry interval while a run is still open', () => {
    expect(delayAfter(run('2026-01-01T00:00:00.000Z', null), CONFIG)).toBe(10_000);
  });
});

describe('milliseconds until the next sweep', () => {
  it('is zero when nothing has ever run', () => {
    // A fresh deployment is the case where waiting an interval before the first sweep would be
    // worst: everything the matrix governs is already as old as the data.
    expect(msUntilDue(null, CONFIG, at('2026-01-01T00:00:00.000Z'))).toBe(0);
  });

  it('counts down from the last run rather than from the process starting', () => {
    const last = run('2026-01-01T00:00:00.000Z', 'SUCCEEDED');
    expect(msUntilDue(last, CONFIG, at('2026-01-01T00:00:00.000Z'))).toBe(60_000);
    expect(msUntilDue(last, CONFIG, at('2026-01-01T00:00:45.000Z'))).toBe(15_000);
  });

  it('is zero at exactly the interval, not one tick after it', () => {
    const last = run('2026-01-01T00:00:00.000Z', 'SUCCEEDED');
    expect(msUntilDue(last, CONFIG, at('2026-01-01T00:00:59.999Z'))).toBe(1);
    expect(msUntilDue(last, CONFIG, at('2026-01-01T00:01:00.000Z'))).toBe(0);
  });

  it('is zero, not negative, for a worker that has been down for a week', () => {
    // The restart case. A worker returning after an outage sweeps immediately, and a negative
    // wait would be handed to setTimeout and become an immediate one anyway - but only by luck.
    const last = run('2026-01-01T00:00:00.000Z', 'SUCCEEDED');
    expect(msUntilDue(last, CONFIG, at('2026-01-08T00:00:00.000Z'))).toBe(0);
  });

  it('does not restart the countdown when the process does', () => {
    // Two "restarts" thirty seconds apart, one history. Both agree on when the next sweep is,
    // which is the property that makes the schedule durable rather than a timer that got lucky.
    const last = run('2026-01-01T00:00:00.000Z', 'SUCCEEDED');
    const first = msUntilDue(last, CONFIG, at('2026-01-01T00:00:10.000Z'));
    const second = msUntilDue(last, CONFIG, at('2026-01-01T00:00:40.000Z'));
    expect(first).toBe(50_000);
    expect(second).toBe(20_000);
    expect(first - second).toBe(30_000);
  });

  it('uses the retry interval for a run that did not fully succeed', () => {
    const last = run('2026-01-01T00:00:00.000Z', 'PARTIAL');
    expect(msUntilDue(last, CONFIG, at('2026-01-01T00:00:05.000Z'))).toBe(5_000);
  });
});
