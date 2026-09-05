import { describe, it, expect } from 'vitest';
import { instantFrom } from '@kynviora/domain';
import * as views from './views.js';
import {
  ageText,
  checklistView,
  decisionFormView,
  operationsView,
  queueView,
  requestDetailView,
  shadowRunView,
  tallyLines,
} from './views.js';
import type {
  OperationsResponse,
  QueueItemResponse,
  QueueResponse,
  RequestDetailResponse,
  ShadowRunResponse,
} from './client.js';

const NOW = instantFrom('2026-09-01T12:00:00.000Z');
const REVIEWER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const REQUEST_ID = '00000000-0000-4000-8000-0000000000aa';

function queueItem(overrides: Partial<QueueItemResponse> = {}): QueueItemResponse {
  return {
    requestId: REQUEST_ID,
    subjectKind: 'assessment_rule_version',
    subjectId: '00000000-0000-4000-8000-0000000000cc',
    action: 'PUBLISH',
    jurisdictions: ['GB', 'NI'],
    maxUrgency: 'HIGH',
    evidenceLevel: 'B',
    requiredApprovals: 2,
    requestedAt: '2026-09-01T09:00:00.000Z',
    tally: [
      { jurisdiction: 'GB', approvals: 2 },
      { jurisdiction: 'NI', approvals: 1 },
    ],
    youMayApprove: true,
    ...overrides,
  };
}

function detail(overrides: Partial<RequestDetailResponse> = {}): RequestDetailResponse {
  return {
    requestId: REQUEST_ID,
    subjectKind: 'assessment_rule_version',
    subjectId: '00000000-0000-4000-8000-0000000000cc',
    action: 'PUBLISH',
    jurisdictions: ['GB', 'NI'],
    maxUrgency: 'HIGH',
    evidenceLevel: 'B',
    requiredApprovals: 2,
    state: 'OPEN',
    requestedByUserId: OTHER,
    requestedAt: '2026-09-01T09:00:00.000Z',
    withdrawalReason: null,
    shadowRunId: '00000000-0000-4000-8000-0000000000bb',
    decidedAt: null,
    approvals: [],
    tally: [
      { jurisdiction: 'GB', approvals: 2 },
      { jurisdiction: 'NI', approvals: 2 },
    ],
    serverTime: NOW,
    ...overrides,
  };
}

const RUN: ShadowRunResponse = {
  shadowRunId: '00000000-0000-4000-8000-0000000000bb',
  ruleVersionId: '00000000-0000-4000-8000-0000000000cc',
  datasetKind: 'SYNTHETIC',
  datasetLabel: 'fixture set',
  datasetSize: 40,
  matchedItems: 6,
  affectedProducts: 3,
  affectedFormulations: 4,
  potentialUserMatches: 5,
  reasonCounts: { INGREDIENT_MATCH: 4, BATCH_MATCH: 2 },
  runAt: '2026-08-31T09:00:00.000Z',
  samples: [
    {
      ownedItemId: '00000000-0000-4000-8000-0000000000dd',
      matched: true,
      matchConfidence: 'EXACT',
      reasons: ['INGREDIENT_MATCH'],
      evidenceLevel: 'B',
      urgency: 'HIGH',
    },
  ],
  serverTime: NOW,
};

describe('the tally is per jurisdiction', () => {
  it('never sums across jurisdictions', () => {
    const lines = tallyLines(
      [
        { jurisdiction: 'GB', approvals: 2 },
        { jurisdiction: 'NI', approvals: 0 },
      ],
      2,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]?.satisfied).toBe(true);
    expect(lines[1]?.satisfied).toBe(false);
    // A single "2 of 4" would read as half done, and there is no such quantity: 0012 requires
    // each jurisdiction to reach the count on its own.
    expect(lines.map((line) => line.text)).toEqual([
      '2 of 2 approvals for GB',
      '0 of 2 approvals for NI',
    ]);
  });
});

describe('ages', () => {
  it('reports whole units and never rounds up', () => {
    expect(ageText('2026-09-01T09:00:00.000Z', NOW)).toBe('3 hours');
    expect(ageText('2026-09-01T08:59:00.000Z', NOW)).toBe('3 hours');
    expect(ageText('2026-09-01T11:59:30.000Z', NOW)).toBe('less than a minute');
    expect(ageText('2026-08-30T12:00:00.000Z', NOW)).toBe('2 days');
  });

  it('says "unknown" rather than inventing a number for an unparseable date', () => {
    expect(ageText('not a date', NOW)).toBe('unknown');
  });
});

describe('the queue', () => {
  it('preserves the order the API returned', () => {
    const oldest = queueItem({ requestId: REQUEST_ID, requestedAt: '2026-09-01T07:00:00.000Z' });
    const newerButUrgent = queueItem({
      requestId: '00000000-0000-4000-8000-0000000000ee',
      requestedAt: '2026-09-01T11:00:00.000Z',
      maxUrgency: 'CRITICAL',
    });
    const response: QueueResponse = { items: [oldest, newerButUrgent], serverTime: NOW };

    const view = queueView(response, NOW);
    // The requester sets `maxUrgency`. If the console sorted by it, whoever opens a request would
    // choose how soon it is looked at.
    expect(view.rows.map((row) => row.requestId)).toEqual([
      oldest.requestId,
      newerButUrgent.requestId,
    ]);
  });

  it('exports no function that compares two requests', () => {
    const suspicious = Object.keys(views).filter((name) =>
      /compare|rank|sort|severity|worst|priorit/i.test(name),
    );
    expect(suspicious).toEqual([]);
  });

  it('names the jurisdictions still short rather than counting them', () => {
    const view = queueView({ items: [queueItem()], serverTime: NOW }, NOW);
    expect(view.rows[0]?.shortOf).toEqual(['NI']);
  });

  it('states why a decision control is absent, as a rule rather than as a judgement', () => {
    const view = queueView({ items: [queueItem({ youMayApprove: false })], serverTime: NOW }, NOW);
    expect(view.rows[0]?.mayNotApproveBecause).toContain('authoring and approving separate');
  });

  it('says an empty queue is not a statement that anything was published', () => {
    const view = queueView({ items: [], serverTime: NOW }, NOW);
    expect(view.emptyMessage).toContain('BLK-004');
  });
});

describe('the checklist', () => {
  it('returns every item unconfirmed', () => {
    const view = checklistView('PUBLISH', true);
    expect(view.items).toHaveLength(10);
    expect(view.items.every((item) => item.confirmed === false)).toBe(true);
  });

  it('is required for a two-person publication and not for a withdrawal', () => {
    expect(checklistView('PUBLISH', true).required).toBe(true);
    expect(checklistView('PUBLISH', false).required).toBe(false);
    // DEC-031: withdrawal is deliberately cheaper. A wrongly-published alert tells someone to
    // act; a wrongly-withdrawn one only removes information.
    expect(checklistView('WITHDRAW', true).required).toBe(false);
  });

  it('offers the items even when they are not required, and says they are kept', () => {
    const view = checklistView('WITHDRAW', true);
    expect(view.items).toHaveLength(10);
    expect(view.note).toContain('kept with the approval');
  });

  it('gives every item a sentence a reviewer can act on', () => {
    for (const item of checklistView('PUBLISH', true).items) {
      expect(item.text.length).toBeGreaterThan(20);
      expect(item.text).not.toBe(item.item);
    }
  });
});

describe('the request detail', () => {
  it('joins the shadow run the request names', () => {
    const view = requestDetailView({
      detail: detail(),
      shadowRun: RUN,
      viewerUserId: REVIEWER,
      now: NOW,
    });
    expect(view.shadowRun?.shadowRunId).toBe(RUN.shadowRunId);
    // The figure EXPECTED_MATCH_VOLUME is about, named as the checklist names it.
    expect(view.shadowRun?.lines.map((line) => line.label)).toContain('People this would reach');
  });

  it('warns rather than guesses when the named run could not be loaded', () => {
    const view = requestDetailView({
      detail: detail(),
      shadowRun: null,
      viewerUserId: REVIEWER,
      now: NOW,
    });
    expect(view.shadowRunNote).toContain('could not be loaded');
    expect(view.shadowRunNote).toContain('Do not confirm the expected match volume from memory');
  });

  it('says a two-person rule publication with no run cannot be executed', () => {
    const view = requestDetailView({
      detail: detail({ shadowRunId: null }),
      shadowRun: null,
      viewerUserId: REVIEWER,
      now: NOW,
    });
    expect(view.shadowRunNote).toContain('0013');
  });

  it('offers execute when every jurisdiction has its approvals', () => {
    const view = requestDetailView({
      detail: detail(),
      shadowRun: RUN,
      viewerUserId: REVIEWER,
      now: NOW,
    });
    expect(view.mayExecute).toBe(true);
  });

  it('names the jurisdictions still short instead of offering execute', () => {
    const view = requestDetailView({
      detail: detail({
        tally: [
          { jurisdiction: 'GB', approvals: 2 },
          { jurisdiction: 'NI', approvals: 1 },
        ],
      }),
      shadowRun: RUN,
      viewerUserId: REVIEWER,
      now: NOW,
    });
    expect(view.mayExecute).toBe(false);
    expect(view.mayExecuteBecause).toContain('NI');
  });

  it('bars the requester from publishing their own request', () => {
    const view = requestDetailView({
      detail: detail({ requestedByUserId: REVIEWER }),
      shadowRun: RUN,
      viewerUserId: REVIEWER,
      now: NOW,
    });
    expect(view.mayExecute).toBe(false);
    expect(view.mayExecuteBecause).toContain('authoring and publishing separate');
  });

  it('does not bar the requester from withdrawing their own request', () => {
    // DEC-031, and the console must not "fix" the asymmetry by hiding the control.
    const view = requestDetailView({
      detail: detail({
        requestedByUserId: REVIEWER,
        action: 'WITHDRAW',
        requiredApprovals: 1,
        tally: [
          { jurisdiction: 'GB', approvals: 1 },
          { jurisdiction: 'NI', approvals: 1 },
        ],
      }),
      shadowRun: null,
      viewerUserId: REVIEWER,
      now: NOW,
    });
    expect(view.mayExecute).toBe(true);
  });

  it('offers no execute control on a request that is already decided', () => {
    const view = requestDetailView({
      detail: detail({ state: 'EXECUTED' }),
      shadowRun: RUN,
      viewerUserId: REVIEWER,
      now: NOW,
    });
    expect(view.mayExecute).toBe(false);
  });

  it('lists only the roles that may judge this kind of content', () => {
    const clinical = requestDetailView({
      detail: detail({ subjectKind: 'assessment_rule_version' }),
      shadowRun: RUN,
      viewerUserId: REVIEWER,
      now: NOW,
    });
    const legal = requestDetailView({
      detail: detail({ subjectKind: 'regulatory_rule_version' }),
      shadowRun: null,
      viewerUserId: REVIEWER,
      now: NOW,
    });

    // `10` keeps regulatory interpretation separate from clinical safety (DEC-032). A console
    // listing every role would invite two people neither of whom is qualified.
    expect(clinical.rolesThatMayApprove).toContain('CLINICAL_SAFETY_LEAD');
    expect(clinical.rolesThatMayApprove).not.toContain('REGULATORY_LEGAL_REVIEWER');
    expect(legal.rolesThatMayApprove).toEqual(['REGULATORY_LEGAL_REVIEWER']);
  });

  it('lists nothing rather than everything for an unrecognised subject kind', () => {
    const view = requestDetailView({
      detail: detail({ subjectKind: 'something_new' }),
      shadowRun: null,
      viewerUserId: REVIEWER,
      now: NOW,
    });
    expect(view.rolesThatMayApprove).toEqual([]);
  });
});

describe('the shadow run view', () => {
  it('says the samples carry no person', () => {
    expect(shadowRunView(RUN).sampleNote).toContain('no person');
  });

  it('reports the run’s own counts and computes none of its own', () => {
    const view = shadowRunView(RUN);
    const values = view.lines.map((line) => line.value);
    expect(values).toEqual(['40', '6', '3', '4', '5']);
  });

  it('orders reason counts by name, not by size', () => {
    // Sorting by count would put the loudest reason first, which is a judgement about which
    // finding matters. Alphabetical is the order that expresses none.
    expect(shadowRunView(RUN).reasonCounts.map((entry) => entry.reason)).toEqual([
      'BATCH_MATCH',
      'INGREDIENT_MATCH',
    ]);
  });
});

describe('the decision form', () => {
  it('preselects nothing and marks nothing as recommended', () => {
    const form = decisionFormView(detail());
    expect(form.decisions.map((option) => option.value)).toEqual([
      'APPROVE',
      'REJECT',
      'RETURN_FOR_CORRECTION',
    ]);
    for (const option of form.decisions) {
      expect(Object.keys(option)).toEqual(['value', 'text']);
    }
  });

  it('offers only the jurisdictions this request asked for', () => {
    const form = decisionFormView(detail({ jurisdictions: ['GB'] }));
    expect(form.jurisdictions).toEqual(['GB']);
  });

  it('drops a jurisdiction this build does not define rather than passing it through', () => {
    const form = decisionFormView(detail({ jurisdictions: ['GB', 'XX'] }));
    expect(form.jurisdictions).toEqual(['GB']);
  });
});

describe('the operations view', () => {
  const response: OperationsResponse = {
    at: NOW,
    metrics: [
      { key: 'reviewer_queue_open_requests', value: 3, unit: 'COUNT' },
      { key: 'reviewer_queue_oldest_open_age_ms', value: 7_200_000, unit: 'MILLISECONDS' },
      { key: 'publication_blocked', value: 0, unit: 'BOOLEAN' },
    ],
    sources: [
      {
        sourceId: 's1',
        organization: 'Example Regulator',
        sourceName: 'Annex III',
        jurisdiction: 'EU',
        status: 'ACTIVE',
        parserVersion: '1',
        operationalOwner: null,
        expectedRefreshIntervalMs: 86_400_000,
        lastAttemptedCheckAt: null,
        lastSuccessfulCheckAt: null,
        lastNewRecordAt: null,
        consecutiveFailureCount: 3,
        overdueByMs: null,
        neverSucceeded: true,
        unowned: true,
      },
    ],
    serverTime: NOW,
  };

  it('reaches no verdict of any kind', () => {
    const view = operationsView(response);
    // The data, without the sentence that explains why there is no verdict - that sentence has
    // to be able to use the word "healthy" in order to say the page will not claim it.
    const serialised = JSON.stringify({ metrics: view.metrics, sources: view.sources });
    for (const word of ['healthy', 'HEALTHY', 'degraded', 'DEGRADED', 'severity', 'score']) {
      expect(serialised).not.toContain(word);
    }
    expect(view.noVerdictNote).toContain('BLK-008');
  });

  it('renders a unit rather than a bare number', () => {
    const view = operationsView(response);
    expect(view.metrics[1]?.value).toBe('2 hours');
    expect(view.metrics[2]?.value).toBe('no');
    expect(view.metrics[0]?.value).toBe('3');
  });

  it('states each source finding separately rather than as one status', () => {
    const notes = operationsView(response).sources[0]?.notes ?? [];
    expect(notes).toContain('Never successfully checked.');
    expect(notes).toContain('No operational owner is named.');
    expect(notes).toContain('3 consecutive failed checks.');
  });

  it('does not report a never-checked source as zero milliseconds overdue', () => {
    const notes = operationsView(response).sources[0]?.notes ?? [];
    expect(notes.some((note) => note.includes('refresh interval'))).toBe(false);
  });
});

describe('a retention age of zero on the operations page', () => {
  it('is not rendered as an empty queue', () => {
    // `nothing waiting` is queue wording and reads as all-clear. Zero here means either no sweep
    // has ever completed or one started within this minute, and only one of those is fine.
    const view = operationsView({
      at: '2026-09-01T12:00:00.000Z',
      serverTime: '2026-09-01T12:00:00.000Z',
      metrics: [
        { key: 'retention_last_successful_run_age_ms', value: 0, unit: 'MILLISECONDS' },
        { key: 'retention_never_swept', value: 1, unit: 'BOOLEAN' },
        { key: 'review_tasks_oldest_open_age_ms', value: 0, unit: 'MILLISECONDS' },
      ],
      sources: [],
    });

    const text = (key: string) => view.metrics.find((m) => m.key === key)?.value;
    expect(text('retention_last_successful_run_age_ms')).toBe('never, or just now');
    // The companion boolean is what resolves the ambiguity, in the same table.
    expect(text('retention_never_swept')).toBe('yes');
    // And a genuine queue age keeps the wording that is right for it.
    expect(text('review_tasks_oldest_open_age_ms')).toBe('nothing waiting');
  });

  it('renders a real retention age the way it renders any other', () => {
    const view = operationsView({
      at: '2026-09-01T12:00:00.000Z',
      serverTime: '2026-09-01T12:00:00.000Z',
      metrics: [
        {
          key: 'retention_last_successful_run_age_ms',
          value: 3 * 60 * 60 * 1000,
          unit: 'MILLISECONDS',
        },
      ],
      sources: [],
    });
    expect(view.metrics[0]?.value).toBe('3 hours');
  });
});
