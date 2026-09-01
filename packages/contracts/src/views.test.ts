import { describe, it, expect } from 'vitest';
import {
  SAFETY_EMPTY_COVERAGE,
  alertView,
  asCaregiverAccessState,
  asChosenDetailLevel,
  asNotificationDetailLevel,
  asReviewTaskKind,
  caregiverAccessRows,
  reviewInboxView,
  asActionUrgency,
  asEvidenceLevel,
  asItemKind,
  asItemVerification,
  asMatchConfidence,
  safetyView,
  shelfItemView,
  shelfView,
} from './views.js';
import type { AlertSummary, ShelfItem } from './client.js';
import { findForbiddenClaims } from '@kynviora/presentation';

const ITEM: ShelfItem = {
  id: 'i1',
  profileId: 'p1',
  itemKind: 'MEDICINE',
  displayName: 'Synthetic Tablet A',
  brand: null,
  lifecycleState: 'ACTIVE',
  identityVerification: 'CONFIRMED',
  formulationVerification: 'PARTIAL',
  batchVerification: 'UNVERIFIED',
  lastReviewedAt: null,
  lastSafetyCheckedAt: null,
};

const ALERT: AlertSummary = {
  id: 'a1',
  profileId: 'p1',
  ownedItemId: 'i1',
  publishedAt: '2026-09-01T00:00:00.000Z',
  urgency: 'HIGH',
  evidenceLevel: 'A',
  matchConfidence: 'EXACT',
  explanationTemplateId: 'BATCH_RECALL_V1',
};

describe('an unrecognised value is never good news', () => {
  it('reads an unknown verification as unverified', () => {
    // A newer server, a proxy rewriting a body, or a bug. Whichever it is, the answer must not be
    // a badge saying this medicine was confirmed.
    expect(asItemVerification('SUPER_CONFIRMED')).toBe('UNVERIFIED');
    expect(asItemVerification('')).toBe('UNVERIFIED');
    expect(asItemVerification('CONFIRMED')).toBe('CONFIRMED');
  });

  it('reads an unknown match confidence as no match', () => {
    expect(asMatchConfidence('VERY_LIKELY')).toBe('NOT_MATCHED');
    expect(asMatchConfidence('EXACT')).toBe('EXACT');
  });

  it('reads an unknown evidence level as unclassified', () => {
    // `U` asserts nothing, which is the correct thing to assert about a value we cannot read.
    expect(asEvidenceLevel('A+')).toBe('U');
    expect(asEvidenceLevel('A')).toBe('A');
  });

  it('reads an unknown urgency as informational, not as critical', () => {
    // The one fallback that goes quiet rather than cautious. `02` and `18` require a product that
    // does not optimise for alarm, and "act now" raised because a string failed to parse is a
    // false alarm with a medicine's name attached to it. `09` sets the same default for a foreign
    // regulatory difference.
    expect(asActionUrgency('EXTREMELY_URGENT')).toBe('INFORMATIONAL');
    expect(asActionUrgency('CRITICAL')).toBe('CRITICAL');
  });

  it('reads an unknown item kind as personal care', () => {
    // The kind with no medicine-specific workflow attached to it.
    expect(asItemKind('DEVICE')).toBe('PERSONAL_CARE');
    expect(asItemKind('MEDICINE')).toBe('MEDICINE');
  });
});

describe('the shelf keeps three verification axes apart', () => {
  it('presents identity, formula and batch as separate statements', () => {
    // `18`: "Product identity confirmed", "Formula confirmed from this label" and "Batch not
    // entered" are different statements and must not share one label.
    const view = shelfItemView(ITEM);
    const labels = [view.identity.label, view.formulation.label, view.batch.label];
    expect(new Set(labels).size).toBe(3);
    expect(view.identity.label).toMatch(/Product/);
    expect(view.formulation.label).toMatch(/Formula/);
    expect(view.batch.label).toMatch(/Batch/);
  });

  it('has no combined verification field', () => {
    // `02` forbids an aggregate Trust Passport score, and one badge summarising three axes is
    // that score with the number left off.
    const view = shelfItemView(ITEM);
    for (const forbidden of ['verified', 'verification', 'trustScore', 'score', 'overall']) {
      expect(Object.keys(view)).not.toContain(forbidden);
    }
  });

  it('counts what is on the shelf and nothing about attention', () => {
    const view = shelfView([ITEM, { ...ITEM, id: 'i2', itemKind: 'PERSONAL_CARE' }], null);
    expect(view.medicineCount).toBe(1);
    expect(view.personalCareCount).toBe(1);
    for (const key of Object.keys(view)) {
      expect(key).not.toMatch(/attention|urgent|critical|issue|problem|risk/i);
    }
  });

  it('reports another page only when the server offered a cursor', () => {
    expect(shelfView([ITEM], null).hasMore).toBe(false);
    expect(shelfView([ITEM], 'i1').hasMore).toBe(true);
  });
});

describe('safety keeps evidence and urgency apart', () => {
  it('presents them as separate fields', () => {
    // `23` D-005 forbids combining them into a single severity, and several tests across this
    // codebase assert no conversion between the two types exists anywhere. Three fields is what
    // keeps "how sure is this" and "what should I do" separately answerable.
    const view = alertView(ALERT);
    expect(view.urgency.label).not.toBe(view.evidence.label);
    expect(view.match.label).not.toBe(view.urgency.label);
  });

  it('has no severity, score or combined field', () => {
    const view = alertView(ALERT);
    for (const key of Object.keys(view)) {
      expect(key.toLowerCase()).not.toMatch(/severity|score|rank|level$|combined|overall/);
    }
  });

  it('states its coverage whether or not there are alerts', () => {
    // `09`: the coverage statement accompanies the result rather than being inferred from its
    // absence. An empty safety screen is not a clean bill of health.
    expect(safetyView([]).coverageStatement).toBe(SAFETY_EMPTY_COVERAGE);
    expect(safetyView([ALERT]).coverageStatement).toBe(SAFETY_EMPTY_COVERAGE);
  });

  it('does not present an empty result as reassurance', () => {
    // The specific misreading: "no alerts, so this medicine is fine". Given BLK-006 and DEC-016
    // nothing is publishable at all right now, so every profile's Safety screen is empty and
    // none of that emptiness says anything about the products on the shelf.
    // Word boundaries matter here: "safety information" is exactly what this sentence is
    // about, and only a bare "safe" would be the reassurance the rule forbids.
    expect(SAFETY_EMPTY_COVERAGE.toLowerCase()).not.toMatch(
      /\bsafe\b|\bfine\b|no problems|all good|nothing wrong|you are ok|no risks?\b/,
    );
    expect(SAFETY_EMPTY_COVERAGE).toMatch(/not the same as/i);
    expect(findForbiddenClaims(SAFETY_EMPTY_COVERAGE)).toEqual([]);
  });
});

describe('an unrecognised review task kind is dropped, not guessed', () => {
  it('keeps the kinds it knows and counts the rest', () => {
    // The presentation layer holds one description per kind and no default. A fallback label
    // would put words next to somebody's medicine record that no reviewer wrote.
    const view = reviewInboxView([
      {
        taskId: 't1',
        kind: 'BATCH_MISSING',
        subjectKind: 'OWNED_ITEM',
        subjectId: 'i1',
        subjectLabel: 'Synthetic Tablet A',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
      {
        taskId: 't2',
        kind: 'SOMETHING_NEWER',
        subjectKind: 'OWNED_ITEM',
        subjectId: 'i2',
        subjectLabel: 'Synthetic Capsule B',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ]);
    expect(view.tasks).toHaveLength(1);
    expect(view.tasks[0]?.kind).toBe('BATCH_MISSING');
    expect(view.unrecognisedCount).toBe(1);
    // The record the completion will write to. `evaluateCompletion` refuses a change targeting
    // anything else, so a view without it would show a task nobody can complete (DEC-027).
    expect(view.tasks[0]?.subjectId).toBe('i1');
  });

  it('reports zero dropped rows when everything was understood', () => {
    // The count is what lets the screen distinguish "there is nothing" from "there is something
    // I could not show you", which `06` requires to be visible rather than silent.
    expect(reviewInboxView([]).unrecognisedCount).toBe(0);
  });

  it('refuses an unknown kind rather than substituting one', () => {
    expect(asReviewTaskKind('BATCH_MISSING')).toBe('BATCH_MISSING');
    expect(asReviewTaskKind('NOT_A_KIND')).toBeNull();
  });
});

describe('caregiver access states fail towards no access', () => {
  it('maps a pending grant to invited', () => {
    // The presentation layer speaks about people rather than rows: "invited and not accepted
    // yet" is the sentence, and the reader does not need the row's status name.
    expect(asCaregiverAccessState('PENDING')).toBe('INVITED');
  });

  it('maps every stored status', () => {
    expect(asCaregiverAccessState('ACTIVE')).toBe('ACTIVE');
    expect(asCaregiverAccessState('EXPIRED')).toBe('EXPIRED');
    expect(asCaregiverAccessState('DECLINED')).toBe('DECLINED');
    expect(asCaregiverAccessState('REVOKED')).toBe('REVOKED');
  });

  it('reads an unknown status as no access rather than as access', () => {
    // The failure directions are not symmetric. Showing "has access" for a status this client
    // cannot read states, in words, that somebody can see a person's health data when nobody
    // knows whether they can.
    expect(asCaregiverAccessState('SOMETHING_NEWER')).toBe('REVOKED');
    expect(asCaregiverAccessState('')).toBe('REVOKED');
  });

  it('drops a capability it cannot describe', () => {
    const rows = caregiverAccessRows([
      {
        id: 'g1',
        profileId: 'p1',
        granteeUserId: 'u2',
        grantedByUserId: 'u1',
        capabilities: ['VIEW_SHELF', 'FLY_A_PLANE'],
        status: 'ACTIVE',
        invitedAt: '2026-09-01T00:00:00.000Z',
        acceptedAt: null,
        expiresAt: null,
        revokedAt: null,
      },
    ]);
    expect(rows[0]?.capabilities).toEqual(['VIEW_SHELF']);
  });

  it('never substitutes an email address for a missing display name', () => {
    // `14` treats an address as personal data and this screen may be read over someone's
    // shoulder. The user ID is meaningless to a bystander, which is the point.
    const rows = caregiverAccessRows([
      {
        id: 'g1',
        profileId: 'p1',
        granteeUserId: 'user-2',
        grantedByUserId: 'u1',
        capabilities: [],
        status: 'ACTIVE',
        invitedAt: '2026-09-01T00:00:00.000Z',
        acceptedAt: null,
        expiresAt: null,
        revokedAt: null,
      },
    ]);
    expect(rows[0]?.displayName).toBe('user-2');
    expect(rows[0]?.displayName).not.toMatch(/@/);
  });
});

describe('a missing notification preference is never permission', () => {
  it('defaults to the quietest level', () => {
    // DEC-025: both dials default to GENERIC precisely so a missing row cannot become consent to
    // put a medicine's name on a locked screen.
    expect(asNotificationDetailLevel(null)).toBe('GENERIC');
    expect(asNotificationDetailLevel('SHOUT_IT')).toBe('GENERIC');
    expect(asNotificationDetailLevel('NAMED')).toBe('NAMED');
  });

  it('keeps "never chosen" distinct from "chose GENERIC"', () => {
    // Two different facts, and the settings screen says which one it is. Collapsing them shows
    // the default as though it were a decision somebody made.
    expect(asChosenDetailLevel(null)).toBeNull();
    expect(asChosenDetailLevel('GENERIC')).toBe('GENERIC');
    expect(asChosenDetailLevel('SHOUT_IT')).toBeNull();
  });
});
