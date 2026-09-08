import { describe, expect, it } from 'vitest';
import type { CaregiverCapability } from '@kynviora/domain';
import {
  CARE_CIRCLE_STATEMENT,
  CARE_CIRCLE_STATUSES,
  EXPIRY_NOTICE_DAYS,
  careCircle,
  careCircleCard,
  careCircleStatusFor,
  careCircleStatusPresentation,
  daysUntilExpiry,
  type CareCircleStatus,
} from './careCircle.js';
import { ICON_NAMES } from './status.js';
import type { CaregiverAccessState } from './caregiver.js';

const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const DAY = 86_400_000;
const inDays = (n: number) => new Date(NOW + n * DAY).toISOString();

function row(over: Partial<Parameters<typeof careCircleCard>[0]> = {}) {
  return {
    id: 'grant-1',
    subject: 'GRANT' as const,
    state: 'ACTIVE' as CaregiverAccessState,
    capabilities: ['VIEW_MEDICINES', 'RECORD_DOSES'] as readonly CaregiverCapability[],
    displayName: 'A caregiver (synthetic)',
    expiresAt: null as string | null,
    isSelf: false,
    ...over,
  };
}

describe('the four statuses V3 asks for', () => {
  it('names an active grant with no end date as having none', () => {
    // An indefinite grant is a decision, and it used to look exactly like every other active one.
    // `16`: a relationship is not a licence, and an expiry nobody set is worth seeing.
    expect(careCircleStatusFor(row({ expiresAt: null }), NOW)).toBe('NO_EXPIRY');
  });

  it('names an expiry inside the notice window as expiring', () => {
    expect(careCircleStatusFor(row({ expiresAt: inDays(9) }), NOW)).toBe('EXPIRING');
    expect(careCircleStatusFor(row({ expiresAt: inDays(EXPIRY_NOTICE_DAYS) }), NOW)).toBe(
      'EXPIRING',
    );
  });

  it('leaves an expiry beyond the window as ordinary', () => {
    // A grant with a year on it must not wear a countdown, or the word means nothing by the time
    // it matters.
    expect(careCircleStatusFor(row({ expiresAt: inDays(EXPIRY_NOTICE_DAYS + 1) }), NOW)).toBe(
      'ACTIVE',
    );
    expect(careCircleStatusFor(row({ expiresAt: inDays(365) }), NOW)).toBe('ACTIVE');
  });

  it('reads a lapsed expiry as ended even when the list still says active', () => {
    // The server is the authority on what is *admitted* - `has_capability` re-evaluates the expiry
    // per access - and this is a screen refusing to tell somebody lapsed access is live while a
    // stale list is on it.
    expect(careCircleStatusFor(row({ expiresAt: inDays(-1) }), NOW)).toBe('EXPIRED');
  });

  it('never calls an unaccepted invitation expiring', () => {
    // Saying "expiring" about access nobody has accepted would be describing the end of something
    // that never started.
    expect(careCircleStatusFor(row({ state: 'INVITED', expiresAt: inDays(2) }), NOW)).toBe(
      'INVITED',
    );
  });

  it('leaves an unreadable date as active rather than guessing either way', () => {
    expect(careCircleStatusFor(row({ expiresAt: 'next Tuesday' }), NOW)).toBe('ACTIVE');
  });

  it('passes every other state through unchanged', () => {
    for (const state of ['EXPIRED', 'DECLINED', 'REVOKED'] as const) {
      expect(careCircleStatusFor(row({ state }), NOW), state).toBe(state);
    }
  });
});

describe('how a status is presented', () => {
  it('gives each one a word, a shape and a sentence', () => {
    for (const status of CARE_CIRCLE_STATUSES) {
      const p = careCircleStatusPresentation(status);
      expect(p.label.length, status).toBeGreaterThan(0);
      expect(ICON_NAMES as readonly string[], status).toContain(p.iconName);
      expect(p.meaning, status).toMatch(/\.$/);
    }
  });

  it('draws an expiry in attention and never in action', () => {
    // An expiry is a date arriving, not a concern somebody reviewed. `23` D-005 keeps urgency and
    // evidence in different geometry, and this is that rule applied to a status chip.
    expect(careCircleStatusPresentation('EXPIRING').tone).toBe('attention');
    for (const status of CARE_CIRCLE_STATUSES) {
      expect(careCircleStatusPresentation(status).tone, status).not.toBe('action');
    }
  });

  it('describes removal as ordinary rather than as a warning', () => {
    // `15` wants removing access to be easy. Styling it as an alarm discourages the thing the
    // threat model most wants somebody to do.
    for (const status of ['REVOKED', 'DECLINED', 'EXPIRED'] as const) {
      expect(careCircleStatusPresentation(status).tone, status).toBe('neutral');
    }
  });

  it('says what an ended grant means for the records rather than only for the person', () => {
    expect(careCircleStatusPresentation('EXPIRING').meaning).toMatch(
      /Nothing happens to their records/,
    );
  });

  it('falls back for a status from outside the set', () => {
    // DEC-147.
    expect(careCircleStatusPresentation('constructor' as CareCircleStatus).label).toBe('Ended');
  });
});

describe('daysUntilExpiry', () => {
  it('rounds up, so an expiry hours away is not reported as gone', () => {
    expect(daysUntilExpiry(new Date(NOW + 19 * 3_600_000).toISOString(), NOW)).toBe(1);
    expect(daysUntilExpiry(inDays(12), NOW)).toBe(12);
  });

  it('answers null where there is nothing to count', () => {
    expect(daysUntilExpiry(null, NOW)).toBeNull();
    expect(daysUntilExpiry('not a date', NOW)).toBeNull();
  });

  it('answers zero for an expiry already past', () => {
    expect(daysUntilExpiry(inDays(-3), NOW)).toBe(0);
  });
});

describe('a card', () => {
  it('keeps what they can see and what they can change on separate lines', () => {
    // `08.2` scopes viewing and changing separately. A card that ran them together would be
    // describing one permission where there are two.
    const card = careCircleCard(row(), NOW);
    expect(card.canSee).toEqual(['Medicines']);
    expect(card.canChange).toEqual(['Record doses']);
  });

  it('states an expiry in days, and an absent one as an absence', () => {
    expect(careCircleCard(row({ expiresAt: inDays(12) }), NOW).expirySentence).toBe(
      'Ends in 12 days',
    );
    expect(careCircleCard(row({ expiresAt: inDays(1) }), NOW).expirySentence).toBe('Ends in 1 day');
    expect(careCircleCard(row({ expiresAt: null }), NOW).expirySentence).toBe('No end date');
  });

  it('says nothing about an expiry on access that has already ended', () => {
    expect(careCircleCard(row({ state: 'REVOKED' }), NOW).expirySentence).toBeNull();
  });

  it('announces who, then the state, then what it covers', () => {
    const said = careCircleCard(row({ expiresAt: inDays(9) }), NOW).accessibilityLabel;
    expect(said.indexOf('A caregiver (synthetic)')).toBeLessThan(said.indexOf('Expiring soon'));
    expect(said.indexOf('Expiring soon')).toBeLessThan(said.indexOf('Can see:'));
    expect(said).toContain('Ends in 9 days.');
  });

  it('says plainly when a grant covers nothing rather than leaving the line out', () => {
    // An omitted line reads as "not applicable". `18`: an absence has to be legible as one.
    const card = careCircleCard(row({ capabilities: [] }), NOW);
    expect(card.accessibilityLabel).toContain('They can see nothing.');
    expect(card.accessibilityLabel).toContain('They cannot change anything.');
  });

  it('says when a row is the caller’s own', () => {
    // "They will stop seeing this profile" is the wrong sentence in front of somebody removing
    // their own access.
    expect(careCircleCard(row({ isSelf: true }), NOW).accessibilityLabel).toContain(
      'This is your own access.',
    );
  });
});

describe('the circle', () => {
  it('keeps the server’s order rather than ranking people', () => {
    // `02` forbids ranking, and a circle sorted by "most urgent" would be sorting people.
    const rows = [
      row({ id: 'a', expiresAt: inDays(200) }),
      row({ id: 'b', expiresAt: inDays(2) }),
      row({ id: 'c', state: 'INVITED' }),
    ];
    expect(careCircle(rows, NOW).current.map((card) => card.id)).toEqual(['a', 'b', 'c']);
  });

  it('counts access that has ended rather than drawing a card for each', () => {
    // Measured, not preferred. One card is 1,587 pixels on a Pixel 7 at font scale 2, and the
    // development profile carries seven revoked grants - drawn as cards they put `Invite someone`
    // about eleven thousand pixels below the fold, which is a primary action nobody reaches.
    const circle = careCircle(
      [
        row({ id: 'live' }),
        row({ id: 'gone-1', state: 'REVOKED' }),
        row({ id: 'gone-2', state: 'EXPIRED' }),
        row({ id: 'gone-3', state: 'DECLINED' }),
      ],
      NOW,
    );
    expect(circle.current.map((card) => card.id)).toEqual(['live']);
    expect(circle.endedCount).toBe(3);
  });

  it('states the count rather than omitting it, and says where the rows are', () => {
    // A count and not an omission: `18` will not let an absence pass unlabelled, and the rows it
    // counts are enumerated in the access list directly beneath.
    const circle = careCircle([row({ id: 'gone', state: 'REVOKED' })], NOW);
    expect(circle.endedSentence).toBe(
      '1 person no longer has access. They are listed below, with what happened.',
    );
    expect(careCircle([row()], NOW).endedSentence).toBeNull();
  });

  it('counts a lapsed expiry as ended, because that is what the status says', () => {
    // The two derived statuses have to fall on the right side of the split, or a grant that
    // expired yesterday would sit in the circle as though somebody still had access.
    const circle = careCircle([row({ expiresAt: inDays(-1) }), row({ expiresAt: inDays(9) })], NOW);
    expect(circle.endedCount).toBe(1);
    expect(circle.current[0]?.status).toBe('EXPIRING');
  });

  it('carries a statement that being family is not access', () => {
    // `16`, in the app's own words, on the screen where it decides something - and present in
    // every state including the empty one (DEC-138's reason).
    expect(CARE_CIRCLE_STATEMENT).toMatch(/not access on its own/i);
  });
});
