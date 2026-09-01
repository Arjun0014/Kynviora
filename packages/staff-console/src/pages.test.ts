import { describe, it, expect } from 'vitest';
import { instantFrom } from '@kynviora/domain';
import { UnsafeMarkup, el, escapeHtml, page, text } from './html.js';
import {
  FORM_TOKEN_FIELD,
  operationsPage,
  outcomePage,
  queuePage,
  requestPage,
  signInPage,
} from './pages.js';
import {
  decisionFormView,
  operationsView,
  queueView,
  requestDetailView,
  type RequestDetailView,
} from './views.js';
import { beginStaffSession, staffSessionWarnings } from './session.js';
import type {
  OperationsResponse,
  QueueItemResponse,
  RequestDetailResponse,
  ShadowRunResponse,
} from './client.js';

const NOW = instantFrom('2026-09-01T12:00:00.000Z');
const REVIEWER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const REQUEST_ID = '00000000-0000-4000-8000-0000000000aa';
const TOKEN = 'form-token-for-this-session';

const SHELL = {
  warnings: staffSessionWarnings(beginStaffSession(REVIEWER, NOW)).map((w) => w.text),
  userId: REVIEWER,
};

/** A value shaped like an attempt to break out of the page. */
const HOSTILE = '</script><img src=x onerror="alert(1)">&"\'';

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
  reasonCounts: { INGREDIENT_MATCH: 4 },
  runAt: '2026-08-31T09:00:00.000Z',
  samples: [],
  serverTime: NOW,
};

function viewFor(overrides: Partial<RequestDetailResponse> = {}): RequestDetailView {
  return requestDetailView({
    detail: detail(overrides),
    shadowRun: RUN,
    viewerUserId: REVIEWER,
    now: NOW,
  });
}

// ---------------------------------------------------------------------------
// The markup helpers
// ---------------------------------------------------------------------------

describe('escaping', () => {
  it('escapes the five characters that matter in both contexts', () => {
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
  });

  it('escapes the ampersand first, so nothing is double-escaped', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('escapes text put into an element', () => {
    // The escaped output still *contains* the characters "onerror=" as text - that is the point,
    // it is inert prose now. The property is that no tag survived, so the test looks for the
    // angle bracket rather than for a scary-looking word.
    const markup = text('p', HOSTILE);
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('</script>');
    expect(markup).toBe(`<p>${escapeHtml(HOSTILE)}</p>`);
  });

  it('escapes a value put into an attribute', () => {
    const markup = el('a', { href: '"><script>' }, []);
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('&quot;&gt;&lt;script&gt;');
  });
});

describe('the attribute allowlist', () => {
  it('refuses an event handler', () => {
    expect(() => el('div', { onclick: 'x()' })).toThrow(UnsafeMarkup);
  });

  it('refuses an attribute nobody added on purpose', () => {
    // An allowlist rather than a denylist: the names that matter include every one HTML has not
    // gained yet, and a denylist has to be updated for those.
    expect(() => el('iframe', { srcdoc: 'x' })).toThrow(UnsafeMarkup);
    expect(() => el('div', { style: 'x' })).toThrow(UnsafeMarkup);
  });

  it('refuses a tag name that is not a plain element', () => {
    expect(() => el('div onclick=x', {})).toThrow(UnsafeMarkup);
  });

  it('emits a boolean attribute as present, not as ="true"', () => {
    expect(el('input', { type: 'checkbox', checked: true })).toBe(
      '<input type="checkbox" checked>',
    );
  });

  it('omits a false or undefined attribute entirely', () => {
    expect(el('input', { type: 'checkbox', checked: false, value: undefined })).toBe(
      '<input type="checkbox">',
    );
  });
});

describe('the page shell', () => {
  it('renders the standing warnings before the content, on every page', () => {
    // Distinctive markers: "content" appears in the viewport meta tag, which made an earlier
    // version of this test compare the warning against the document head.
    const html = page({ title: 'T', warnings: ['WARNING-MARKER'], userId: REVIEWER }, [
      text('p', 'BODY-MARKER'),
    ]);
    expect(html.indexOf('WARNING-MARKER')).toBeLessThan(html.indexOf('BODY-MARKER'));
  });

  it('loads nothing from anywhere else', () => {
    const html = page({ title: 'T', warnings: [], userId: null }, []);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });
});

// ---------------------------------------------------------------------------
// The pages
// ---------------------------------------------------------------------------

describe('the sign-in page', () => {
  it('says it is not an authentication step', () => {
    const html = signInPage({ message: null });
    expect(html).toContain('not an authentication step');
    expect(html).toContain('BLK-010');
  });

  it('says a user ID with no reviewer row will find every page empty', () => {
    expect(signInPage({ message: null })).toContain('authority comes from a row in the reviewer');
  });
});

describe('the queue page', () => {
  it('says why it is not ordered by urgency', () => {
    const html = queuePage(queueView({ items: [queueItem()], serverTime: NOW }, NOW), SHELL);
    expect(html).toContain('never ordered by declared urgency');
  });

  it('shows the per-jurisdiction tally rather than one number', () => {
    const html = queuePage(queueView({ items: [queueItem()], serverTime: NOW }, NOW), SHELL);
    expect(html).toContain('2 of 2 approvals for GB');
    expect(html).toContain('1 of 2 approvals for NI');
  });

  it('says an empty queue is not a claim that anything was published', () => {
    const html = queuePage(queueView({ items: [], serverTime: NOW }, NOW), SHELL);
    expect(html).toContain('BLK-004');
  });

  it('escapes a hostile subject kind from the API', () => {
    const html = queuePage(
      queueView({ items: [queueItem({ subjectKind: HOSTILE })], serverTime: NOW }, NOW),
      SHELL,
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('</script>');
    expect(html).toContain(escapeHtml(HOSTILE));
  });
});

describe('the request page', () => {
  const form = decisionFormView(detail());

  it('preselects no decision and pre-ticks no checklist item', () => {
    const html = requestPage(viewFor(), form, SHELL, {
      canDecide: true,
      message: null,
      formToken: TOKEN,
    });
    // The `checked` **attribute** appears nowhere. The word does, in checklist copy such as "I
    // checked the shadow run", which is why this looks for the attribute rather than the word.
    expect(html).not.toContain(' checked>');
    expect(html).not.toContain('checked=');
    // And every input that could have carried it is present, so the assertion is over a form
    // that exists rather than over an empty page.
    expect(html.match(/<input type="checkbox"/g)?.length).toBe(12);
  });

  it('offers no control that ticks the checklist in bulk', () => {
    const html = requestPage(viewFor(), form, SHELL, {
      canDecide: true,
      message: null,
      formToken: TOKEN,
    });
    expect(html.toLowerCase()).not.toContain('select all');
    expect(html.toLowerCase()).not.toContain('confirm all');
    expect(html.toLowerCase()).not.toContain('tick all');
  });

  it('renders all ten checklist items with their sentences', () => {
    const html = requestPage(viewFor(), form, SHELL, {
      canDecide: true,
      message: null,
      formToken: TOKEN,
    });
    expect(html).toContain('I retrieved the source document myself');
    expect(html).toContain('Somebody is named as responsible');
  });

  it('joins the shadow run rather than printing its identifier alone', () => {
    const html = requestPage(viewFor(), form, SHELL, {
      canDecide: true,
      message: null,
      formToken: TOKEN,
    });
    // DEV-017's remainder: a reviewer confirming EXPECTED_MATCH_VOLUME had to fetch the run
    // separately, and now does not.
    expect(html).toContain('People this would reach');
    expect(html).toContain('Items evaluated');
  });

  it('offers no decision form to the requester, and says which rule removed it', () => {
    const html = requestPage(viewFor({ requestedByUserId: REVIEWER }), form, SHELL, {
      canDecide: false,
      message: null,
      formToken: TOKEN,
    });
    expect(html).not.toContain('Record this decision');
    expect(html).toContain('authoring and approving separate');
  });

  it('offers no publish control while a jurisdiction is short, and names it', () => {
    const html = requestPage(
      viewFor({
        tally: [
          { jurisdiction: 'GB', approvals: 2 },
          { jurisdiction: 'NI', approvals: 0 },
        ],
      }),
      form,
      SHELL,
      { canDecide: true, message: null, formToken: TOKEN },
    );
    expect(html).not.toContain('Publish now');
    expect(html).toContain('NI');
  });

  it('offers the publish control once every jurisdiction has its approvals', () => {
    const html = requestPage(viewFor(), form, SHELL, {
      canDecide: true,
      message: null,
      formToken: TOKEN,
    });
    expect(html).toContain('Publish now');
  });

  it('says the decisions so far are append-only', () => {
    const html = requestPage(
      viewFor({
        approvals: [
          {
            approvalId: '00000000-0000-4000-8000-0000000000ff',
            reviewerUserId: OTHER,
            role: 'CLINICAL_SAFETY_LEAD',
            decision: 'APPROVE',
            jurisdictions: ['GB'],
            note: 'checked the source',
            decidedAt: '2026-09-01T10:00:00.000Z',
          },
        ],
      }),
      form,
      SHELL,
      { canDecide: true, message: null, formToken: TOKEN },
    );
    expect(html).toContain('Append-only');
    expect(html).toContain('checked the source');
  });

  it('escapes a hostile note recorded by another reviewer', () => {
    const html = requestPage(
      viewFor({
        approvals: [
          {
            approvalId: '00000000-0000-4000-8000-0000000000ff',
            reviewerUserId: OTHER,
            role: 'CLINICAL_SAFETY_LEAD',
            decision: 'APPROVE',
            jurisdictions: ['GB'],
            note: HOSTILE,
            decidedAt: '2026-09-01T10:00:00.000Z',
          },
        ],
      }),
      form,
      SHELL,
      { canDecide: true, message: null, formToken: TOKEN },
    );
    // A reviewer's note is free text stored in the database. It reaches this page and it must not
    // be able to act on it.
    expect(html).not.toContain('<img');
    expect(html).not.toContain('</script>');
    expect(html).toContain(escapeHtml(HOSTILE));
  });

  it('offers no decision or execute control on a closed request', () => {
    const html = requestPage(viewFor({ state: 'EXECUTED' }), form, SHELL, {
      canDecide: true,
      message: null,
      formToken: TOKEN,
    });
    expect(html).not.toContain('Record this decision');
    expect(html).not.toContain('Publish now');
  });

  it('offers only the roles that may judge this kind', () => {
    const legalDetail = detail({ subjectKind: 'regulatory_rule_version' });
    const html = requestPage(
      requestDetailView({
        detail: legalDetail,
        shadowRun: null,
        viewerUserId: REVIEWER,
        now: NOW,
      }),
      decisionFormView(legalDetail),
      SHELL,
      { canDecide: true, message: null, formToken: TOKEN },
    );
    expect(html).toContain('REGULATORY_LEGAL_REVIEWER');
    expect(html).not.toContain('CLINICAL_SAFETY_LEAD');
  });
});

describe('the form token', () => {
  const form = decisionFormView(detail());

  it('appears in every form that changes something', () => {
    const html = requestPage(viewFor(), form, SHELL, {
      canDecide: true,
      message: null,
      formToken: TOKEN,
    });
    // One in the decision form, one in the execute form. `SameSite=Strict` on the cookie is the
    // first lock and this is the second; on a surface that can publish safety content, one
    // control an old browser or a proxy can undo is not enough.
    const occurrences = html.split(`name="${FORM_TOKEN_FIELD}" value="${TOKEN}"`).length - 1;
    expect(occurrences).toBe(2);
  });

  it('appears in the publication block form', () => {
    const html = operationsPage(
      operationsView({ at: NOW, metrics: [], sources: [], serverTime: NOW }),
      SHELL,
      { publicationBlocked: false, message: null, formToken: TOKEN },
    );
    expect(html).toContain(`name="${FORM_TOKEN_FIELD}" value="${TOKEN}"`);
  });

  it('appears in the step-up form', () => {
    const html = outcomePage(
      'STEP_UP_REQUIRED',
      { message: null, correlationId: null, formToken: TOKEN },
      SHELL,
    );
    expect(html).toContain(`name="${FORM_TOKEN_FIELD}" value="${TOKEN}"`);
  });

  it('is escaped like any other value', () => {
    const html = outcomePage(
      'STEP_UP_REQUIRED',
      { message: null, correlationId: null, formToken: '"><script>' },
      SHELL,
    );
    expect(html).not.toContain('<script>');
  });
});

describe('the operations page', () => {
  const response: OperationsResponse = {
    at: NOW,
    metrics: [{ key: 'reviewer_queue_open_requests', value: 3, unit: 'COUNT' }],
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
        consecutiveFailureCount: 0,
        overdueByMs: null,
        neverSucceeded: true,
        unowned: true,
      },
    ],
    serverTime: NOW,
  };

  it('says there is no overall status and why', () => {
    const html = operationsPage(operationsView(response), SHELL, {
      publicationBlocked: false,
      message: null,
      formToken: TOKEN,
    });
    expect(html).toContain('no overall status');
    expect(html).toContain('BLK-008');
  });

  it('asks for a reason before blocking publication', () => {
    const html = operationsPage(operationsView(response), SHELL, {
      publicationBlocked: false,
      message: null,
      formToken: TOKEN,
    });
    expect(html).toContain('Why publication is being blocked (required)');
  });

  it('offers to lift a block without asking for a reason', () => {
    const html = operationsPage(operationsView(response), SHELL, {
      publicationBlocked: true,
      message: null,
      formToken: TOKEN,
    });
    expect(html).toContain('Lift the block');
    expect(html).not.toContain('Why publication is being blocked');
  });

  it('says that blocking publication never blocks a withdrawal', () => {
    const html = operationsPage(operationsView(response), SHELL, {
      publicationBlocked: true,
      message: null,
      formToken: TOKEN,
    });
    expect(html).toContain('never blocks a withdrawal');
  });

  it('names a source with nobody responsible for it', () => {
    const html = operationsPage(operationsView(response), SHELL, {
      publicationBlocked: false,
      message: null,
      formToken: TOKEN,
    });
    expect(html).toContain('nobody named');
    expect(html).toContain('Never successfully checked.');
  });
});

describe('the outcome pages', () => {
  it('says nothing about why something is unavailable', () => {
    const html = outcomePage(
      'UNAVAILABLE',
      { message: null, correlationId: null, formToken: TOKEN },
      SHELL,
    );
    // The API refuses to distinguish "does not exist" from "you may not see it" from "you hold no
    // reviewer row". A page that guessed would hand back the fact the 404 was chosen to withhold.
    expect(html).toContain('does not distinguish them');
    expect(html.toLowerCase()).not.toContain('permission');
    expect(html.toLowerCase()).not.toContain('not a reviewer');
  });

  it('offers a step-up control when that is what is needed', () => {
    const html = outcomePage(
      'STEP_UP_REQUIRED',
      { message: null, correlationId: null, formToken: TOKEN },
      SHELL,
    );
    expect(html).toContain('Confirm my identity');
  });

  it('does not claim an action failed when the server did not answer', () => {
    const html = outcomePage(
      'SERVER_ERROR',
      { message: null, correlationId: 'abc', formToken: TOKEN },
      SHELL,
    );
    expect(html).toContain('Nothing here says whether the action was recorded');
    expect(html).toContain('abc');
  });

  it('says nothing was recorded when the request never left', () => {
    const html = outcomePage(
      'OFFLINE',
      { message: null, correlationId: null, formToken: TOKEN },
      SHELL,
    );
    expect(html).toContain('Nothing was recorded');
  });
});
