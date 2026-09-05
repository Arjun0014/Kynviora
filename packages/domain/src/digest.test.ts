import { describe, it, expect } from 'vitest';
import { instantFrom } from './ports.js';
import { DIGEST_LOCAL_HOUR, assembleDigest, digestDue, type DigestCandidate } from './digest.js';

/**
 * The digest's two decisions: when, and what survives.
 *
 * Spec references: `04` Phase 7.5 (digest policy; revalidation before inclusion), `09`, DEC-119,
 * `DEV-033`.
 *
 * WHAT IS WORTH ASSERTING HERE
 * Not that a filter filters. That a **withdrawn alert cannot reach a digest**, that the cadence is
 * read in the recipient's own morning rather than a server's, and that a recipient whose zone
 * nobody knows gets no digest at all rather than one assembled at a guessed hour. Each of those is
 * a place where the easy implementation is wrong in a way nobody would notice for months.
 */

const at = (iso: string) => instantFrom(iso);

const KOLKATA = 'Asia/Kolkata';
const LONDON = 'Europe/London';

function candidate(over: Partial<DigestCandidate> = {}): DigestCandidate {
  return {
    alertDeliveryId: 'delivery-1',
    notifiedAt: at('2026-09-04T10:00:00.000Z'),
    currentState: 'PUBLISHED',
    lastCorrectedAt: null,
    ...over,
  };
}

describe('when a digest is due', () => {
  it('is due once the recipient’s own 09:00 has passed', () => {
    // 04:00 UTC is 09:30 in Kolkata. The hour is theirs, not the server's - a digest arriving in
    // the middle of somebody's night would be the interruption the digest exists to avoid.
    const due = digestDue({
      at: at('2026-09-05T04:00:00.000Z'),
      zone: KOLKATA,
      lastLocalDate: null,
    });
    expect(due).toEqual({ due: true, localDate: '2026-09-05' });
  });

  it('is not due before it, in the same instant, for somebody else', () => {
    // The same moment is 05:00 in London, four hours before their morning.
    expect(
      digestDue({ at: at('2026-09-05T04:00:00.000Z'), zone: LONDON, lastLocalDate: null }),
    ).toEqual({ due: false, reason: 'BEFORE_LOCAL_HOUR' });
  });

  it('is due at exactly the hour, not a minute after it', () => {
    // 03:30 UTC is exactly 09:00 in Kolkata.
    expect(
      digestDue({ at: at('2026-09-05T03:30:00.000Z'), zone: KOLKATA, lastLocalDate: null }).due,
    ).toBe(true);
    expect(
      digestDue({ at: at('2026-09-05T03:29:00.000Z'), zone: KOLKATA, lastLocalDate: null }),
    ).toEqual({ due: false, reason: 'BEFORE_LOCAL_HOUR' });
  });

  it('is not due twice on the same local day', () => {
    expect(
      digestDue({
        at: at('2026-09-05T12:00:00.000Z'),
        zone: KOLKATA,
        lastLocalDate: '2026-09-05',
      }),
    ).toEqual({ due: false, reason: 'ALREADY_ASSEMBLED' });
  });

  it('is due again the next local day', () => {
    expect(
      digestDue({
        at: at('2026-09-06T04:00:00.000Z'),
        zone: KOLKATA,
        lastLocalDate: '2026-09-05',
      }),
    ).toEqual({ due: true, localDate: '2026-09-06' });
  });

  it('is never due for a recipient whose zone nobody knows', () => {
    // DEC-119 refuses to invent a zone for quiet hours; this is the same refusal at the other end.
    // Assembling at a guessed hour would mean telling somebody "here is your morning" at four in
    // the morning, and their events are already reachable in the app either way.
    for (const zone of [null, undefined, '', '+05:30', 'Mars/Olympus']) {
      expect(digestDue({ at: at('2026-09-05T12:00:00.000Z'), zone, lastLocalDate: null })).toEqual({
        due: false,
        reason: 'ZONE_UNKNOWN',
      });
    }
  });

  it('reports an already-assembled day as such rather than as a clock problem', () => {
    // Checked before the hour, so a second pass at 02:00 local on a day that already has one reads
    // as ALREADY_ASSEMBLED rather than BEFORE_LOCAL_HOUR - which would send an operator looking at
    // time zones for a question about idempotence.
    expect(
      digestDue({
        at: at('2026-09-05T20:30:00.000Z'),
        zone: KOLKATA,
        lastLocalDate: '2026-09-06',
      }),
    ).toEqual({ due: false, reason: 'ALREADY_ASSEMBLED' });
  });

  it('uses 09:00 as the approved hour', () => {
    expect(DIGEST_LOCAL_HOUR).toBe(9);
  });
});

describe('what survives assembly', () => {
  it('keeps an alert that is still published', () => {
    const result = assembleDigest([candidate()]);
    expect(result.includedCount).toBe(1);
    expect(result.droppedCount).toBe(0);
    expect(result.entries[0]?.outcome).toBe('STILL_CURRENT');
    expect(result.entries[0]?.included).toBe(true);
  });

  it('drops an alert the recipient can no longer see', () => {
    // `null` is what a re-read as the recipient produces for a withdrawn alert, a superseded one,
    // and one whose caregiver grant has been revoked. All three are the same fact from where the
    // digest is assembled, and none of them belongs in it.
    const result = assembleDigest([candidate({ currentState: null })]);
    expect(result.includedCount).toBe(0);
    expect(result.entries[0]?.outcome).toBe('NO_LONGER_VISIBLE');
    expect(result.entries[0]?.included).toBe(false);
  });

  it('drops one corrected since the notification', () => {
    // `04` Phase 7.5's second exit criterion. A summary that reported a corrected assessment as
    // current would breach it in the one format nobody re-reads, because a digest looks like a
    // settled account of what happened.
    const result = assembleDigest([
      candidate({
        notifiedAt: at('2026-09-04T10:00:00.000Z'),
        lastCorrectedAt: at('2026-09-04T18:00:00.000Z'),
      }),
    ]);
    expect(result.entries[0]?.outcome).toBe('CORRECTED_SINCE_NOTIFICATION');
    expect(result.includedCount).toBe(0);
  });

  it('keeps one corrected before the notification, which is not news', () => {
    const result = assembleDigest([
      candidate({
        notifiedAt: at('2026-09-04T10:00:00.000Z'),
        lastCorrectedAt: at('2026-09-03T18:00:00.000Z'),
      }),
    ]);
    expect(result.entries[0]?.outcome).toBe('STILL_CURRENT');
  });

  it('records every candidate, including the ones it dropped', () => {
    // A row per candidate rather than per included item. "Why is this not in my digest" is a
    // question a digest generates and is unanswerable from a list of what survived - and it is
    // what stops a dropped item being reconsidered every morning for the rest of time.
    const result = assembleDigest([
      candidate({ alertDeliveryId: 'a' }),
      candidate({ alertDeliveryId: 'b', currentState: null }),
      candidate({ alertDeliveryId: 'c', currentState: 'PUBLISHED' }),
    ]);
    expect(result.entries.map((e) => e.alertDeliveryId)).toEqual(['a', 'b', 'c']);
    expect(result.includedCount).toBe(2);
    expect(result.droppedCount).toBe(1);
  });

  it('never marks an entry included unless it is still current', () => {
    // The two columns are one statement. `included` reads `revalidate`'s own `actionable`, so
    // there is one definition of "still true" in this codebase rather than two that agree today.
    const result = assembleDigest([
      candidate({ alertDeliveryId: 'a', currentState: null }),
      candidate({ alertDeliveryId: 'b', currentState: 'WITHDRAWN' }),
      candidate({ alertDeliveryId: 'c', currentState: 'SUPERSEDED' }),
      candidate({
        alertDeliveryId: 'd',
        lastCorrectedAt: at('2026-09-05T10:00:00.000Z'),
      }),
    ]);
    for (const entry of result.entries) {
      expect(entry.included).toBe(entry.outcome === 'STILL_CURRENT');
      expect(entry.included).toBe(false);
    }
    expect(result.includedCount).toBe(0);
    expect(result.droppedCount).toBe(4);
  });

  it('assembles nothing from nothing', () => {
    expect(assembleDigest([])).toEqual({ entries: [], includedCount: 0, droppedCount: 0 });
  });

  it('holds nothing renderable', () => {
    // An entry is a reference plus what a re-read found. No title, no body, no medicine, no
    // person - so a digest can never disclose more than a live read would, because it has nothing
    // to disclose.
    const entry = assembleDigest([candidate()]).entries[0];
    expect(Object.keys(entry ?? {}).sort()).toEqual(['alertDeliveryId', 'included', 'outcome']);
  });
});
