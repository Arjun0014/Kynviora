import { describe, it, expect } from 'vitest';
import * as safetyInbox from './safetyInbox.js';
import {
  STATE_FOR_URGENCY,
  deriveItemSafetyState,
  filterSafetyInbox,
  type ItemSafetyInput,
  type SafetyInboxLine,
} from './safetyInbox.js';
import { ACTION_URGENCIES, EVIDENCE_LEVELS, MATCH_CONFIDENCES } from './vocabulary.js';
import type { Instant } from './ports.js';

/**
 * Phase 7.1's two exit criteria, as tests.
 *
 * "No state implies guaranteed safety" is not a wording rule here - it is a derivation rule. The
 * failure it guards against is an item nobody has checked being shown as one that was checked and
 * came back clear, and no amount of careful copy fixes that.
 *
 * "Evidence level and urgency are visibly separate" is asserted by changing one and expecting
 * nothing.
 */

const AT = '2026-09-01T09:00:00.000Z' as Instant;

const input = (over: Partial<ItemSafetyInput> = {}): ItemSafetyInput => ({
  publishedAlert: null,
  latestAssessment: null,
  ...over,
});

describe('an item nobody has checked never looks like one that came back clear', () => {
  it('is insufficient data, not "nothing matched"', () => {
    // `23` D-014: an absence of a matched rule must never render as approval. Reaching that
    // failure by omission rather than by a wrong label is the same failure.
    expect(deriveItemSafetyState(input()).state).toBe('INSUFFICIENT_DATA');
  });

  it('reports no last-assessed time rather than inventing one', () => {
    // The absence is the point. A screen showing "checked just now" for an item that was never
    // assessed would be the reassurance in a different field.
    expect(deriveItemSafetyState(input()).lastAssessedAt).toBeNull();
  });

  it('is insufficient data when the item could not be identified', () => {
    // `09`: "insufficient data - item/context cannot be matched reliably". Whatever a rule then
    // did, the item was not identified.
    for (const matchConfidence of ['UNCONFIRMED', 'NOT_MATCHED'] as const) {
      const derived = deriveItemSafetyState(
        input({ latestAssessment: { matchConfidence, evaluatedAt: AT } }),
      );
      expect(derived.state).toBe('INSUFFICIENT_DATA');
      expect(derived.lastAssessedAt).toBe(AT);
    }
  });

  it('says nothing matched only where the item was identified and assessed', () => {
    for (const matchConfidence of ['EXACT', 'PROBABLE'] as const) {
      expect(
        deriveItemSafetyState(input({ latestAssessment: { matchConfidence, evaluatedAt: AT } }))
          .state,
      ).toBe('NO_CURRENT_MATCHED_ALERT');
    }
  });

  it('classifies every match confidence the vocabulary has', () => {
    // A new confidence must be classified rather than falling into the reassuring branch.
    for (const matchConfidence of MATCH_CONFIDENCES) {
      const derived = deriveItemSafetyState(
        input({ latestAssessment: { matchConfidence, evaluatedAt: AT } }),
      );
      expect(['NO_CURRENT_MATCHED_ALERT', 'INSUFFICIENT_DATA']).toContain(derived.state);
    }
  });
});

describe('a live alert decides the state, from urgency alone', () => {
  it('maps every urgency, with no default', () => {
    // `09`: "action required - approved action wording based on urgency". A total record, so a new
    // urgency is a decision somebody makes rather than one a fallthrough makes for them.
    expect(Object.keys(STATE_FOR_URGENCY).sort()).toEqual([...ACTION_URGENCIES].sort());
    expect(STATE_FOR_URGENCY.CRITICAL).toBe('ACTION_REQUIRED');
    expect(STATE_FOR_URGENCY.HIGH).toBe('ACTION_REQUIRED');
    expect(STATE_FOR_URGENCY.MEDIUM).toBe('REVIEW');
    expect(STATE_FOR_URGENCY.LOW).toBe('REVIEW');
    expect(STATE_FOR_URGENCY.INFORMATIONAL).toBe('INFORMATION');
  });

  it('carries the urgency and the evidence level beside the state, never folded into it', () => {
    // `23` D-005. The whole point of the separation is that a screen receives both and shows both.
    const derived = deriveItemSafetyState(
      input({
        publishedAlert: { urgency: 'HIGH', evidenceLevel: 'C', matchConfidence: 'EXACT' },
      }),
    );
    expect(derived.state).toBe('ACTION_REQUIRED');
    expect(derived.urgency).toBe('HIGH');
    expect(derived.evidenceLevel).toBe('C');
  });

  it('gives the same state whatever the evidence level', () => {
    // The exit criterion, as an experiment: change one axis and expect nothing on the other.
    const states = EVIDENCE_LEVELS.map(
      (evidenceLevel) =>
        deriveItemSafetyState(
          input({
            publishedAlert: { urgency: 'CRITICAL', evidenceLevel, matchConfidence: 'EXACT' },
          }),
        ).state,
    );
    expect(new Set(states).size).toBe(1);
    expect(states[0]).toBe('ACTION_REQUIRED');
  });

  it('leaves an item with no live alert carrying no urgency at all', () => {
    // Not INFORMATIONAL, which would be an urgency nobody assigned. A line with no alert has no
    // urgency, and the type says so.
    const derived = deriveItemSafetyState(
      input({ latestAssessment: { matchConfidence: 'EXACT', evaluatedAt: AT } }),
    );
    expect(derived.urgency).toBeNull();
    expect(derived.evidenceLevel).toBeNull();
  });

  it('falls back to the assessment once the alert is no longer live', () => {
    // A withdrawn alert must not leave an item showing ACTION_REQUIRED. `19` treats a withdrawn
    // alert resurfacing as release-blocking, and this is the same defect one layer up - so the
    // caller passes `null` for anything not published, and the item reverts to what it was.
    const derived = deriveItemSafetyState(
      input({
        publishedAlert: null,
        latestAssessment: { matchConfidence: 'EXACT', evaluatedAt: AT },
      }),
    );
    expect(derived.state).toBe('NO_CURRENT_MATCHED_ALERT');
  });
});

describe('what this module refuses to be', () => {
  it('exports nothing that scores, ranks or counts', () => {
    // `23` D-005 forbids combining evidence level and urgency; `02` refuses the alarm-optimising
    // product a count on this screen produces.
    const functions = Object.entries(safetyInbox)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name);
    expect(
      functions.filter((n) => /score|rank|sort|count|severity|worst|priorit/i.test(n)),
    ).toEqual([]);
  });

  it('puts no score or ranking on a derived state', () => {
    const derived = deriveItemSafetyState(
      input({ publishedAlert: { urgency: 'HIGH', evidenceLevel: 'A', matchConfidence: 'EXACT' } }),
    );
    expect(Object.keys(derived).sort()).toEqual([
      'evidenceLevel',
      'lastAssessedAt',
      'state',
      'urgency',
    ]);
  });
});

describe('filtering the inbox', () => {
  const line = (over: Partial<SafetyInboxLine> = {}): SafetyInboxLine => ({
    ownedItemId: 'i1',
    displayName: 'Synthetic Tablet A',
    alertPublicationId: null,
    state: 'INSUFFICIENT_DATA',
    urgency: null,
    evidenceLevel: null,
    lastAssessedAt: null,
    ...over,
  });

  const lines: readonly SafetyInboxLine[] = [
    line({ ownedItemId: 'a', state: 'ACTION_REQUIRED', urgency: 'CRITICAL', evidenceLevel: 'A' }),
    line({ ownedItemId: 'b', state: 'REVIEW', urgency: 'MEDIUM', evidenceLevel: 'C' }),
    line({ ownedItemId: 'c', state: 'NO_CURRENT_MATCHED_ALERT' }),
    line({ ownedItemId: 'd' }),
  ];

  it('returns everything when nothing is asked for', () => {
    // An absent filter and an empty one are indistinguishable in a query string, and the harmless
    // reading is the one a screen actually wants.
    expect(filterSafetyInbox(lines)).toHaveLength(4);
    expect(filterSafetyInbox(lines, { states: [], urgencies: [] })).toHaveLength(4);
  });

  it('filters by state', () => {
    expect(filterSafetyInbox(lines, { states: ['REVIEW'] }).map((l) => l.ownedItemId)).toEqual([
      'b',
    ]);
  });

  it('filters by urgency, and excludes lines that have none', () => {
    // Asking for CRITICAL and being shown items with no alert at all would make the filter
    // meaningless.
    expect(
      filterSafetyInbox(lines, { urgencies: ['CRITICAL', 'MEDIUM'] }).map((l) => l.ownedItemId),
    ).toEqual(['a', 'b']);
    expect(filterSafetyInbox(lines, { urgencies: ['LOW'] })).toEqual([]);
  });

  it('applies both filters together', () => {
    expect(
      filterSafetyInbox(lines, { states: ['ACTION_REQUIRED'], urgencies: ['MEDIUM'] }),
    ).toEqual([]);
  });

  it('keeps the order it was given', () => {
    // Not a ranking. `02` refuses "most urgent first" because it is a judgement about which of two
    // people's medicines matters more.
    expect(filterSafetyInbox(lines).map((l) => l.ownedItemId)).toEqual(['a', 'b', 'c', 'd']);
  });
});
