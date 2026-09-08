/**
 * The safety-screen judgements, tested with no device attached (DEC-102).
 *
 * The rule worth reading twice is `SAF-5`. Its first draft rejected any text containing a digit,
 * which fails the app for its own legitimate subset line - "Showing 0 of 3 items on this shelf." -
 * and would have sent somebody to remove the one number on the screen that is a fact rather than a
 * judgement.
 */

import { describe, expect, it } from 'vitest';
import { SAFETY_EMPTY_COVERAGE } from '@kynviora/contracts';
import { presentSafetyState } from '@kynviora/presentation';
import {
  COVERAGE_SENTENCE,
  EXPLAIN_CONTROL,
  INSUFFICIENT_ANNOUNCEMENT,
  INSUFFICIENT_LABEL,
  NEVER_ASSESSED_SENTENCE,
  coverageStatedCheck,
  everyItemHasALineCheck,
  filteredEmptyCheck,
  inboxPreconditionCheck,
  noOrphanExplanationCheck,
  nothingCountedCheck,
  stateIsStatedCheck,
  type InboxLine,
  type InboxResponse,
} from './safetyInbox.js';

function line(overrides: Partial<InboxLine> = {}): InboxLine {
  return {
    ownedItemId: 'i1',
    displayName: 'Synthetic Tablet A',
    alertPublicationId: null,
    state: 'INSUFFICIENT_DATA',
    urgency: null,
    evidenceLevel: null,
    lastAssessedAt: null,
    ...overrides,
  };
}

const INBOX: InboxResponse = {
  lines: [
    line(),
    line({ ownedItemId: 'i2', displayName: 'Synthetic Capsule B' }),
    line({ ownedItemId: 'i3', displayName: 'Synthetic Moisturiser C' }),
  ],
  totalItems: 3,
};

/** A screen with everything on it that a correct one has. */
const GOOD_SCREEN: readonly string[] = [
  'Coverage Center',
  'Every item on this shelf, and what Kynviora can say about it today.',
  'Synthetic Tablet A',
  INSUFFICIENT_ANNOUNCEMENT,
  NEVER_ASSESSED_SENTENCE,
  'Synthetic Capsule B',
  NEVER_ASSESSED_SENTENCE,
  'Synthetic Moisturiser C',
  NEVER_ASSESSED_SENTENCE,
  COVERAGE_SENTENCE,
];

describe('the sentences this harness looks for are the app’s own', () => {
  it('matches the coverage statement the client renders', () => {
    // Written out in `safetyInbox.ts` rather than imported, so a wording change that turned it
    // into reassurance would not be silently agreed with. This test is what keeps the copy of it
    // honest: it has to keep matching, and updating it is a deliberate act.
    expect(COVERAGE_SENTENCE).toBe(SAFETY_EMPTY_COVERAGE);
  });

  it('matches the label the presentation layer gives that state', () => {
    expect(INSUFFICIENT_LABEL).toBe(presentSafetyState('INSUFFICIENT_DATA').label);
  });

  it('matches what a line actually announces, which is not the label', () => {
    expect(INSUFFICIENT_ANNOUNCEMENT).toBe(
      presentSafetyState('INSUFFICIENT_DATA').accessibilityLabel,
    );
  });
});

describe('SAF-0, the control', () => {
  it('passes when the shelf has items and nothing is published about them', () => {
    expect(inboxPreconditionCheck({ inbox: INBOX }).status).toBe('PASS');
  });

  it('refuses to judge an empty shelf', () => {
    // A safety screen with no lines is correct for a profile with nothing on it, so every check
    // below would pass while measuring nothing at all.
    const check = inboxPreconditionCheck({ inbox: { lines: [], totalItems: 0 } });
    expect(check.status).toBe('INCONCLUSIVE');
  });

  it('refuses to judge a profile something has been published for', () => {
    // `BLK-006` says nothing in this build can be approved, so this is worth stopping over
    // rather than working around.
    const check = inboxPreconditionCheck({
      inbox: { ...INBOX, lines: [line({ alertPublicationId: 'pub-1' })] },
    });
    expect(check.status).toBe('INCONCLUSIVE');
  });
});

describe('SAF-1, every item has a line', () => {
  it('passes when every item the server knows about is named', () => {
    expect(everyItemHasALineCheck({ inbox: INBOX, screenText: GOOD_SCREEN }).status).toBe('PASS');
  });

  it('fails when an item with nothing to report is left off', () => {
    // The quietest way to render an absence as approval: the screen looks calm and correct, and
    // the missing item reads as one that was checked and cleared.
    const check = everyItemHasALineCheck({
      inbox: INBOX,
      screenText: GOOD_SCREEN.filter((text) => text !== 'Synthetic Capsule B'),
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('Synthetic Capsule B');
  });

  it('says so when the omission is the server’s rather than the screen’s', () => {
    const check = everyItemHasALineCheck({
      inbox: { lines: [line()], totalItems: 3 },
      screenText: GOOD_SCREEN,
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('upstream');
  });
});

describe('SAF-2, the limitation is stated', () => {
  it('passes when the label and the never-assessed sentence are both on screen', () => {
    expect(stateIsStatedCheck({ inbox: INBOX, screenText: GOOD_SCREEN }).status).toBe('PASS');
  });

  it('fails a screen that shows no state at all', () => {
    const check = stateIsStatedCheck({
      inbox: INBOX,
      screenText: GOOD_SCREEN.filter((text) => text !== INSUFFICIENT_ANNOUNCEMENT),
    });
    expect(check.status).toBe('FAIL');
  });

  it('is not answered by the filter of the same name', () => {
    // This screen draws a filter called "Not enough information". A check for the bare label is
    // satisfied by that filter over lines showing no state at all, which is what the first draft
    // of this rule did.
    const check = stateIsStatedCheck({
      inbox: INBOX,
      screenText: [
        ...GOOD_SCREEN.filter((text) => text !== INSUFFICIENT_ANNOUNCEMENT),
        INSUFFICIENT_LABEL,
      ],
    });
    expect(check.status).toBe('FAIL');
  });

  it('fails a screen that leaves the assessment date blank instead of absent', () => {
    // An item Kynviora has never assessed must not read like one it checked this morning.
    const check = stateIsStatedCheck({
      inbox: INBOX,
      screenText: GOOD_SCREEN.filter((text) => text !== NEVER_ASSESSED_SENTENCE),
    });
    expect(check.status).toBe('FAIL');
  });

  it('does not judge a state it was not written for', () => {
    const check = stateIsStatedCheck({
      inbox: { ...INBOX, lines: [line({ state: 'ACTION_REQUIRED' })] },
      screenText: GOOD_SCREEN,
    });
    expect(check.status).toBe('INCONCLUSIVE');
  });
});

describe('SAF-3, the coverage statement', () => {
  it('passes when the whole sentence is on screen', () => {
    expect(coverageStatedCheck({ inbox: INBOX, screenText: GOOD_SCREEN }).status).toBe('PASS');
  });

  it('names the failure when only the first half survives', () => {
    // "Kynviora has no reviewed safety information" on its own reads as there being nothing to
    // find, which is the exact inversion `18` forbids.
    const check = coverageStatedCheck({
      inbox: INBOX,
      screenText: ['Kynviora has no reviewed safety information to show for this profile.'],
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('second half');
  });
});

describe('SAF-4, no orphan explanation', () => {
  it('passes when no line offers to explain anything', () => {
    const check = noOrphanExplanationCheck({ inbox: INBOX, screenText: GOOD_SCREEN });
    expect(check.status).toBe('PASS');
  });

  it('fails when a control offers an explanation nothing can supply', () => {
    // DEC-045: absent, not disabled. A greyed-out control states that an explanation exists and
    // is being withheld, which on a safety screen is worse than silence.
    const check = noOrphanExplanationCheck({
      inbox: INBOX,
      screenText: [...GOOD_SCREEN, EXPLAIN_CONTROL],
    });
    expect(check.status).toBe('FAIL');
  });
});

describe('SAF-5, nothing counted or ranked', () => {
  it('passes a screen whose only number is the size of the shelf', () => {
    const check = nothingCountedCheck({
      inbox: INBOX,
      screenText: [...GOOD_SCREEN, 'Showing 0 of 3 items on this shelf.'],
    });
    expect(check.status).toBe('PASS');
  });

  it('fails a badge', () => {
    expect(nothingCountedCheck({ inbox: INBOX, screenText: [...GOOD_SCREEN, '3'] }).status).toBe(
      'FAIL',
    );
  });

  it('fails a count of what needs attention', () => {
    const check = nothingCountedCheck({
      inbox: INBOX,
      screenText: [...GOOD_SCREEN, '2 items need action'],
    });
    expect(check.status).toBe('FAIL');
  });

  it('does not read a year or a date as a count', () => {
    const check = nothingCountedCheck({
      inbox: INBOX,
      screenText: [...GOOD_SCREEN, 'Last assessed 2026-09-04.'],
    });
    expect(check.status).toBe('PASS');
  });
});

describe('SAF-6, a filter that matches nothing', () => {
  const filtered = [
    'Coverage Center',
    'Showing 0 of 3 items on this shelf.',
    COVERAGE_SENTENCE,
  ] as readonly string[];

  it('passes when the empty page still says both things', () => {
    const check = filteredEmptyCheck({
      screenText: filtered,
      totalItems: 3,
      excludedNames: ['Synthetic Tablet A', 'Synthetic Capsule B'],
    });
    expect(check.status).toBe('PASS');
  });

  it('fails a filter that did not actually filter', () => {
    const check = filteredEmptyCheck({
      screenText: [...filtered, 'Synthetic Tablet A'],
      totalItems: 3,
      excludedNames: ['Synthetic Tablet A'],
    });
    expect(check.status).toBe('FAIL');
  });

  it('fails when the coverage statement did not survive the filter', () => {
    const check = filteredEmptyCheck({
      screenText: ['Coverage Center', 'Showing 0 of 3 items on this shelf.'],
      totalItems: 3,
      excludedNames: [],
    });
    expect(check.status).toBe('FAIL');
  });

  it('fails when nothing says the page is a subset', () => {
    // Without it, a filtered page with no rows is indistinguishable from a shelf with nothing on
    // it - and the person asked for "action needed", so the difference is the whole answer.
    const check = filteredEmptyCheck({
      screenText: ['Coverage Center', COVERAGE_SENTENCE],
      totalItems: 3,
      excludedNames: [],
    });
    expect(check.status).toBe('FAIL');
  });
});
