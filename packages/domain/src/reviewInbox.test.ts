import { describe, it, expect } from 'vitest';
import {
  COMPLETABLE_FIELDS,
  COMPLETION_CAPABILITIES,
  FORBIDDEN_TASK_FIELDS,
  GRANT_EXPIRY_NOTICE_DAYS,
  ITEM_REVIEW_INTERVAL_DAYS,
  REFILL_ESTIMATE_STALE_DAYS,
  REVIEW_OUTCOMES,
  REVIEW_TASK_KINDS,
  SUBJECT_FOR_KIND,
  deriveTasks,
  evaluateCompletion,
  reviewTaskAuditDetail,
  type CompletionAuthority,
  type CompletionRequest,
  type InboxSnapshot,
  type RecordChange,
  type ReviewTask,
} from './reviewInbox.js';
import { instantFrom, type Instant } from './ports.js';
import { isErr, isOk } from './result.js';
import { unsafeId, type ProfileId, type ReviewTaskId } from './ids.js';

/**
 * Household Review Inbox decisions.
 *
 * Both Phase 8.3 exit criteria are properties of this module rather than of a screen, so both are
 * asserted here: a review task cannot carry alert vocabulary, and a task cannot be closed without
 * writing to the record it is about.
 */

const PROFILE = unsafeId<ProfileId>('44444444-4444-4444-8444-444444444444');
const TASK = unsafeId<ReviewTaskId>('55555555-5555-4555-8555-555555555555');
const ITEM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ITEM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const NOW = instantFrom('2026-08-29T12:00:00.000Z');

function daysAgo(days: number): Instant {
  return new Date(Date.parse(NOW) - days * 24 * 60 * 60 * 1000).toISOString() as Instant;
}
function daysAhead(days: number): Instant {
  return new Date(Date.parse(NOW) + days * 24 * 60 * 60 * 1000).toISOString() as Instant;
}

function emptySnapshot(): InboxSnapshot {
  return { profileId: PROFILE, items: [], grants: [], alerts: [], refillEstimates: [] };
}

function item(overrides: Partial<InboxSnapshot['items'][number]> = {}) {
  return {
    id: ITEM,
    itemKind: 'MEDICINE' as const,
    lifecycleState: 'ACTIVE',
    lastReviewedAt: daysAgo(1),
    createdAt: daysAgo(1),
    batchId: 'batch-1',
    batchVerification: 'CONFIRMED',
    formulationVerification: 'CONFIRMED',
    hasUnresolvedExtraction: false,
    ...overrides,
  };
}

function task(overrides: Partial<ReviewTask> = {}): ReviewTask {
  return {
    id: TASK,
    profileId: PROFILE,
    kind: 'ITEM_NOT_REVIEWED_RECENTLY',
    subjectKind: 'owned_item',
    subjectId: ITEM,
    state: 'OPEN',
    createdAt: NOW,
    ...overrides,
  };
}

const OWNER_AUTHORITY: CompletionAuthority = { isOwner: true, capabilities: [] };

function change(overrides: Partial<RecordChange> = {}): RecordChange {
  return {
    recordKind: 'owned_item',
    recordId: ITEM,
    field: 'last_reviewed_at',
    value: NOW,
    ...overrides,
  };
}

function complete(
  t: ReviewTask,
  request: Partial<CompletionRequest> = {},
  authority: CompletionAuthority = OWNER_AUTHORITY,
) {
  return evaluateCompletion(
    t,
    { outcome: 'RESOLVED', changes: [change()], ...request },
    authority,
    NOW,
  );
}

// ---------------------------------------------------------------------------

describe('a review task is not a safety alert', () => {
  it('carries no urgency, evidence level, severity or score', () => {
    // Exit criterion 1, asserted over the object's own keys rather than trusted to a comment.
    // 09 keeps evidence and urgency as properties of an assessment; a task saying "no batch number
    // recorded" is not an assessment of anything.
    const keys = Object.keys(task());
    for (const forbidden of FORBIDDEN_TASK_FIELDS) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('has a kind vocabulary disjoint from the alert vocabulary', () => {
    // No shared token, so no screen can switch on one and accidentally handle the other.
    const alertish = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL', 'EXACT', 'PROBABLE'];
    for (const kind of REVIEW_TASK_KINDS) {
      expect(alertish).not.toContain(kind);
    }
  });

  it('covers exactly the seven kinds the spec lists', () => {
    expect([...REVIEW_TASK_KINDS].sort()).toEqual(
      [
        'BATCH_MISSING',
        'CAREGIVER_GRANT_EXPIRING',
        'FORMULA_NEEDS_CONFIRMATION',
        'ITEM_NOT_REVIEWED_RECENTLY',
        'OCR_FIELD_UNRESOLVED',
        'REFILL_ESTIMATE_NEEDS_REVIEW',
        'SAFETY_ITEM_AWAITING_CONFIRMATION',
      ].sort(),
    );
  });

  it('gives every kind a subject, a capability and a completable field list', () => {
    for (const kind of REVIEW_TASK_KINDS) {
      expect(SUBJECT_FOR_KIND[kind]).toBeDefined();
      expect(COMPLETION_CAPABILITIES[kind].length).toBeGreaterThan(0);
      expect(COMPLETABLE_FIELDS[kind].length).toBeGreaterThan(0);
    }
  });
});

describe('derivation', () => {
  it('produces nothing from an empty profile', () => {
    expect(deriveTasks(emptySnapshot(), NOW)).toEqual([]);
  });

  it('raises a review task once the interval has passed, and not before', () => {
    const due = deriveTasks(
      { ...emptySnapshot(), items: [item({ lastReviewedAt: daysAgo(ITEM_REVIEW_INTERVAL_DAYS) })] },
      NOW,
    );
    expect(due.map((t) => t.kind)).toContain('ITEM_NOT_REVIEWED_RECENTLY');

    const notYet = deriveTasks(
      {
        ...emptySnapshot(),
        items: [item({ lastReviewedAt: daysAgo(ITEM_REVIEW_INTERVAL_DAYS - 1) })],
      },
      NOW,
    );
    expect(notYet.map((t) => t.kind)).not.toContain('ITEM_NOT_REVIEWED_RECENTLY');
  });

  it('measures an item never reviewed from when it was created', () => {
    // Otherwise a null would either never raise a task or raise one the moment the item is added.
    const fresh = deriveTasks(
      { ...emptySnapshot(), items: [item({ lastReviewedAt: null, createdAt: daysAgo(1) })] },
      NOW,
    );
    expect(fresh.map((t) => t.kind)).not.toContain('ITEM_NOT_REVIEWED_RECENTLY');

    const old = deriveTasks(
      {
        ...emptySnapshot(),
        items: [item({ lastReviewedAt: null, createdAt: daysAgo(ITEM_REVIEW_INTERVAL_DAYS + 1) })],
      },
      NOW,
    );
    expect(old.map((t) => t.kind)).toContain('ITEM_NOT_REVIEWED_RECENTLY');
  });

  it('ignores stopped and archived items entirely', () => {
    // 18 and 02 both push against manufacturing work. Asking someone to re-review a medicine they
    // stopped taking is work about the past.
    for (const lifecycleState of ['STOPPED', 'ARCHIVED']) {
      const derived = deriveTasks(
        {
          ...emptySnapshot(),
          items: [
            item({
              lifecycleState,
              lastReviewedAt: daysAgo(ITEM_REVIEW_INTERVAL_DAYS + 10),
              batchId: null,
              hasUnresolvedExtraction: true,
            }),
          ],
        },
        NOW,
      );
      expect(derived).toEqual([]);
    }
  });

  it('asks for a batch number on a medicine but not on a personal-care product', () => {
    // 03 scopes batch-level recall matching to medicines. Prompting for a lot number on a bottle
    // of shampoo is noise.
    const medicine = deriveTasks({ ...emptySnapshot(), items: [item({ batchId: null })] }, NOW);
    expect(medicine.map((t) => t.kind)).toContain('BATCH_MISSING');

    const personalCare = deriveTasks(
      { ...emptySnapshot(), items: [item({ itemKind: 'PERSONAL_CARE', batchId: null })] },
      NOW,
    );
    expect(personalCare.map((t) => t.kind)).not.toContain('BATCH_MISSING');
  });

  it('asks about a formulation only when the catalog knows it does not know', () => {
    for (const state of ['CONFLICTING', 'PARTIAL']) {
      const derived = deriveTasks(
        { ...emptySnapshot(), items: [item({ formulationVerification: state })] },
        NOW,
      );
      expect(derived.map((t) => t.kind)).toContain('FORMULA_NEEDS_CONFIRMATION');
    }

    // UNVERIFIED is deliberately excluded: a manually entered item with no formulation is a
    // complete, legitimate record under 04 Phase 2.2, not an outstanding task.
    const unverified = deriveTasks(
      { ...emptySnapshot(), items: [item({ formulationVerification: 'UNVERIFIED' })] },
      NOW,
    );
    expect(unverified.map((t) => t.kind)).not.toContain('FORMULA_NEEDS_CONFIRMATION');
  });

  it('raises a grant-expiring task inside the notice window only', () => {
    const soon = deriveTasks(
      {
        ...emptySnapshot(),
        grants: [
          { id: 'g1', status: 'ACTIVE', expiresAt: daysAhead(GRANT_EXPIRY_NOTICE_DAYS - 1) },
        ],
      },
      NOW,
    );
    expect(soon.map((t) => t.kind)).toContain('CAREGIVER_GRANT_EXPIRING');

    const distant = deriveTasks(
      {
        ...emptySnapshot(),
        grants: [
          { id: 'g1', status: 'ACTIVE', expiresAt: daysAhead(GRANT_EXPIRY_NOTICE_DAYS + 5) },
        ],
      },
      NOW,
    );
    expect(distant).toEqual([]);
  });

  it('does not raise a task for a grant that has already expired or been revoked', () => {
    // There is no access left to renew from an inbox, and a lapsed grant belongs on the caregiver
    // surface where the whole picture is.
    const expired = deriveTasks(
      { ...emptySnapshot(), grants: [{ id: 'g1', status: 'ACTIVE', expiresAt: daysAgo(1) }] },
      NOW,
    );
    expect(expired).toEqual([]);

    const revoked = deriveTasks(
      { ...emptySnapshot(), grants: [{ id: 'g1', status: 'REVOKED', expiresAt: daysAhead(2) }] },
      NOW,
    );
    expect(revoked).toEqual([]);
  });

  it('never raises a task for a grant with no expiry', () => {
    const derived = deriveTasks(
      { ...emptySnapshot(), grants: [{ id: 'g1', status: 'ACTIVE', expiresAt: null }] },
      NOW,
    );
    expect(derived).toEqual([]);
  });

  it('asks for confirmation on a published unresolved alert only', () => {
    const open = deriveTasks(
      { ...emptySnapshot(), alerts: [{ id: 'a1', state: 'PUBLISHED', resolution: null }] },
      NOW,
    );
    expect(open.map((t) => t.kind)).toContain('SAFETY_ITEM_AWAITING_CONFIRMATION');

    const resolved = deriveTasks(
      { ...emptySnapshot(), alerts: [{ id: 'a1', state: 'PUBLISHED', resolution: 'REVIEWED' }] },
      NOW,
    );
    expect(resolved).toEqual([]);
  });

  it('never asks about a withdrawn alert', () => {
    // 19 treats a stale withdrawn alert that remains actionable as release-blocking, and an inbox
    // row asking someone to confirm a retracted alert is exactly that.
    for (const state of ['WITHDRAWN', 'SUPERSEDED']) {
      const derived = deriveTasks(
        { ...emptySnapshot(), alerts: [{ id: 'a1', state, resolution: null }] },
        NOW,
      );
      expect(derived).toEqual([]);
    }
  });

  it('raises a refill review when the estimate is stale or its date has passed', () => {
    const stale = deriveTasks(
      {
        ...emptySnapshot(),
        refillEstimates: [
          {
            id: 'r1',
            computedAt: daysAgo(REFILL_ESTIMATE_STALE_DAYS),
            estimatedDepletionOn: null,
          },
        ],
      },
      NOW,
    );
    expect(stale.map((t) => t.kind)).toContain('REFILL_ESTIMATE_NEEDS_REVIEW');

    const passed = deriveTasks(
      {
        ...emptySnapshot(),
        refillEstimates: [{ id: 'r1', computedAt: daysAgo(1), estimatedDepletionOn: '2026-08-01' }],
      },
      NOW,
    );
    expect(passed.map((t) => t.kind)).toContain('REFILL_ESTIMATE_NEEDS_REVIEW');

    const fine = deriveTasks(
      {
        ...emptySnapshot(),
        refillEstimates: [{ id: 'r1', computedAt: daysAgo(1), estimatedDepletionOn: '2026-12-01' }],
      },
      NOW,
    );
    expect(fine).toEqual([]);
  });

  it('is deterministic and repeatable for the same snapshot', () => {
    // Derivation rather than accumulation is what makes the open-task index safe: running it twice
    // must propose the same set, not a growing one.
    const snapshot: InboxSnapshot = {
      ...emptySnapshot(),
      items: [item({ batchId: null, lastReviewedAt: daysAgo(ITEM_REVIEW_INTERVAL_DAYS + 1) })],
    };
    expect(deriveTasks(snapshot, NOW)).toEqual(deriveTasks(snapshot, NOW));
  });

  it('gives every derived task the subject its kind requires', () => {
    const snapshot: InboxSnapshot = {
      profileId: PROFILE,
      items: [
        item({
          batchId: null,
          lastReviewedAt: daysAgo(ITEM_REVIEW_INTERVAL_DAYS + 1),
          formulationVerification: 'CONFLICTING',
          hasUnresolvedExtraction: true,
        }),
      ],
      grants: [{ id: 'g1', status: 'ACTIVE', expiresAt: daysAhead(2) }],
      alerts: [{ id: 'a1', state: 'PUBLISHED', resolution: null }],
      refillEstimates: [{ id: 'r1', computedAt: daysAgo(90), estimatedDepletionOn: null }],
    };
    const derived = deriveTasks(snapshot, NOW);
    expect(derived.length).toBe(7);
    for (const t of derived) {
      expect(t.subjectKind).toBe(SUBJECT_FOR_KIND[t.kind]);
    }
    // All seven kinds reachable, which is what makes the exhaustiveness above meaningful.
    expect(new Set(derived.map((t) => t.kind)).size).toBe(REVIEW_TASK_KINDS.length);
  });
});

describe('completing a task must change the record', () => {
  it('refuses a completion that changes nothing', () => {
    // Exit criterion 2. Without this the inbox is a to-do list, which produces the feeling of
    // having maintained the data without the fact.
    const result = complete(task(), { changes: [] });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.detail).toMatchObject({ reason_code: 'completion_changes_nothing' });
    }
  });

  it('refuses a change to a different record', () => {
    const result = complete(task(), { changes: [change({ recordId: OTHER_ITEM })] });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.detail).toMatchObject({ reason_code: 'change_targets_other_record' });
    }
  });

  it('refuses a change to a different kind of record', () => {
    const result = complete(task(), { changes: [change({ recordKind: 'caregiver_grant' })] });
    expect(isErr(result)).toBe(true);
  });

  it('refuses a field that is not what this task is about', () => {
    // Without the allow-list, a completion could satisfy "change something" by touching an
    // unrelated field, and the inbox would be a general-purpose write endpoint that closes a task.
    const result = complete(task(), { changes: [change({ field: 'display_name' })] });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.detail).toMatchObject({ reason_code: 'field_not_completable' });
    }
  });

  it('requires a change for "not applicable" too', () => {
    // Deciding a task does not apply is itself a fact about the record - "I looked and it is
    // right" is what last_reviewed_at means.
    const result = complete(task(), { outcome: 'NOT_APPLICABLE', changes: [] });
    expect(isErr(result)).toBe(true);
  });

  it('accepts a well-formed completion and reports the resulting state', () => {
    for (const [outcome, state] of [
      ['RESOLVED', 'COMPLETED'],
      ['NOT_APPLICABLE', 'DISMISSED'],
    ] as const) {
      const result = complete(task(), { outcome });
      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.value.resultingState).toBe(state);
        expect(result.value.completedAt).toBe(NOW);
      }
    }
  });

  it('refuses to close an already-closed task', () => {
    for (const state of ['COMPLETED', 'DISMISSED'] as const) {
      const result = complete(task({ state }));
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.detail).toMatchObject({ reason_code: 'task_not_open' });
      }
    }
  });

  it('accepts every completable field for its own kind', () => {
    // Guards against a field being listed but unreachable, which would look like coverage.
    for (const kind of REVIEW_TASK_KINDS) {
      const subjectKind = SUBJECT_FOR_KIND[kind];
      for (const field of COMPLETABLE_FIELDS[kind]) {
        const result = evaluateCompletion(
          task({ kind, subjectKind, subjectId: ITEM }),
          {
            outcome: 'RESOLVED',
            changes: [{ recordKind: subjectKind, recordId: ITEM, field, value: 'x' }],
          },
          OWNER_AUTHORITY,
          NOW,
        );
        expect(isOk(result)).toBe(true);
      }
    }
  });
});

describe('authorization follows the record, not the inbox', () => {
  it('lets the owner complete every kind', () => {
    for (const kind of REVIEW_TASK_KINDS) {
      const subjectKind = SUBJECT_FOR_KIND[kind];
      const field = COMPLETABLE_FIELDS[kind][0] as string;
      const result = evaluateCompletion(
        task({ kind, subjectKind }),
        {
          outcome: 'RESOLVED',
          changes: [{ recordKind: subjectKind, recordId: ITEM, field, value: 'x' }],
        },
        OWNER_AUTHORITY,
        NOW,
      );
      expect(isOk(result)).toBe(true);
    }
  });

  it('refuses a caregiver holding no relevant capability', () => {
    const result = complete(task(), {}, { isOwner: false, capabilities: ['VIEW_SHELF'] });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('PERMISSION_DENIED');
  });

  it('admits a caregiver holding exactly the capability the kind requires', () => {
    const result = complete(task(), {}, { isOwner: false, capabilities: ['MANAGE_SHELF'] });
    expect(isOk(result)).toBe(true);
  });

  it('does not let care access renew a caregiver grant', () => {
    // The sharp case. A single review-inbox permission would let someone with care access extend
    // their own grant by going through a task instead of the surface that governs it.
    const grantTask = task({ kind: 'CAREGIVER_GRANT_EXPIRING', subjectKind: 'caregiver_grant' });
    const request: CompletionRequest = {
      outcome: 'RESOLVED',
      changes: [{ recordKind: 'caregiver_grant', recordId: ITEM, field: 'expires_at', value: NOW }],
    };

    const care = evaluateCompletion(
      grantTask,
      request,
      { isOwner: false, capabilities: ['MANAGE_CARE', 'VIEW_CARE', 'MANAGE_SHELF'] },
      NOW,
    );
    expect(isErr(care)).toBe(true);

    const admin = evaluateCompletion(
      grantTask,
      request,
      { isOwner: false, capabilities: ['MANAGE_CAREGIVERS'] },
      NOW,
    );
    expect(isOk(admin)).toBe(true);
  });

  it('checks authorization before anything else about the request', () => {
    // The cheapest refusal, and the one whose absence would be a security defect rather than a
    // usability one. An unauthorized caller must not learn whether their body was well-formed.
    const result = evaluateCompletion(
      task(),
      { outcome: 'RESOLVED', changes: [] },
      { isOwner: false, capabilities: [] },
      NOW,
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('PERMISSION_DENIED');
  });
});

describe('audit detail', () => {
  it('records field names and counts but never values', () => {
    const detail = reviewTaskAuditDetail({
      kind: 'OCR_FIELD_UNRESOLVED',
      outcome: 'RESOLVED',
      changes: [
        {
          recordKind: 'owned_item',
          recordId: ITEM,
          field: 'strength_text',
          value: '500 mg',
        },
      ],
    });
    expect(detail.fields).toBe('strength_text');
    expect(JSON.stringify(detail)).not.toContain('500 mg');
  });

  it('deduplicates and sorts field names so the detail is stable', () => {
    const detail = reviewTaskAuditDetail({
      kind: 'BATCH_MISSING',
      outcome: 'RESOLVED',
      changes: [
        { recordKind: 'owned_item', recordId: ITEM, field: 'batch_verification', value: 'X' },
        { recordKind: 'owned_item', recordId: ITEM, field: 'batch_id', value: 'Y' },
        { recordKind: 'owned_item', recordId: ITEM, field: 'batch_id', value: 'Z' },
      ],
    });
    expect(detail.fields).toBe('batch_id,batch_verification');
    expect(detail.change_count).toBe(3);
  });

  it('names both outcomes', () => {
    for (const outcome of REVIEW_OUTCOMES) {
      const detail = reviewTaskAuditDetail({
        kind: 'ITEM_NOT_REVIEWED_RECENTLY',
        outcome,
        changes: [change()],
      });
      expect(detail.outcome).toBe(outcome);
    }
  });
});

describe('thresholds are named, not scattered', () => {
  it('exposes each interval as a constant a product decision can change in one place', () => {
    for (const value of [
      ITEM_REVIEW_INTERVAL_DAYS,
      GRANT_EXPIRY_NOTICE_DAYS,
      REFILL_ESTIMATE_STALE_DAYS,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });
});
