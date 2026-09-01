/**
 * The console's pages.
 *
 * Spec references: `04` Phase 6.6 (reviewer queue; source, evidence and legal-scope view; publish
 * / reject / return-for-correction; rule preview), `10` (separation of duties, the high-severity
 * checklist, emergency controls, governance audit artifacts), `20` (the operational snapshot),
 * `13` and `14` (staff surface controls), `DEV-016`, `DEV-017`.
 *
 * Pure functions from a view model to a string. Nothing here fetches, decides authority, or knows
 * what a route is - which is what lets every page be asserted over its actual output rather than
 * over a screenshot nobody looks at.
 *
 * WHAT THESE PAGES REFUSE TO RENDER
 *  - A control the API said this caller may not use. Absent, not disabled: a greyed-out Approve
 *    states that the request exists and that this person is not trusted with it (DEC-045), and on
 *    a separation-of-duties refusal that is the requester learning their own request is waiting.
 *  - A preselected decision, a pre-ticked checklist item, or a control that ticks them together.
 *  - An overall verdict on the operations page (DEC-060), or a queue ordered by claimed urgency.
 */

import { el, page, plain, text, type PageOptions } from './html.js';
import type {
  DecisionFormView,
  OperationsView,
  QueueRowView,
  QueueView,
  RequestDetailView,
  ShadowRunView,
  TallyLine,
} from './views.js';

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

function tallyList(lines: readonly TallyLine[]): string {
  return el(
    'ul',
    { class: 'tally' },
    lines.map((line) => text('li', line.text)),
  );
}

function definition(label: string, value: string): string {
  return el('p', { class: 'meta' }, [text('strong', `${label}: `), plain(value)]);
}

/**
 * The per-session form token.
 *
 * `SameSite=Strict` on the session cookie already stops a cross-site form post in any browser
 * that honours it, and this is the second lock. A reviewer console can publish safety content and
 * withdraw it; `14` lists reviewer compromise as the reason the whole governance chapter exists,
 * and one control that a proxy or an old browser can undo is not enough on that surface.
 *
 * The token is bound to the session rather than to the form, so it cannot be lifted from a page
 * an attacker was allowed to see and replayed against a different session.
 */
function formToken(token: string): string {
  return el('input', { type: 'hidden', name: FORM_TOKEN_FIELD, value: token });
}

/** Field name the server reads the form token from. Exported so the two cannot drift. */
export const FORM_TOKEN_FIELD = 'formToken';

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

/**
 * The sign-in page.
 *
 * It says what it is. `13` and `14` require MFA or a passkey for a reviewer account and there is
 * no provider (`BLK-010`); a form that asked for a user ID and looked like a login would be the
 * console claiming an authentication step it does not perform.
 */
export function signInPage(options: { readonly message: string | null }): string {
  const shell: PageOptions = {
    title: 'Sign in',
    warnings: [
      'This is not an authentication step. Spec 13 and 14 require a passkey or MFA for a ' +
        'reviewer account and no provider is configured (BLK-010). The value below becomes a ' +
        'header the development API accepts; it proves nothing.',
    ],
    userId: null,
  };

  const body = [
    text('h2', 'Identify this session'),
    options.message === null
      ? ''
      : el('p', { class: 'warning' }, [text('strong', options.message)]),
    el('form', { method: 'post', action: '/session' }, [
      el('label', { for: 'userId' }, [plain('Reviewer user ID (UUID)')]),
      el('input', { id: 'userId', name: 'userId', type: 'text', required: true, maxlength: 36 }),
      el('button', { type: 'submit' }, [plain('Begin session')]),
    ]),
    text(
      'p',
      'Whatever you enter here, authority comes from a row in the reviewer table. A user ID with ' +
        'no such row can sign in and will find every page empty, which is the same answer a ' +
        'stranger gets.',
      { class: 'meta' },
    ),
  ];

  return page(shell, body);
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

function queueRow(row: QueueRowView): string {
  const children: string[] = [
    text('h3', `${row.action} - ${row.subjectKind}`),
    definition('Request', row.requestId),
    definition('Subject', row.subjectId),
    definition('Waiting', row.waitingFor),
    // Shown as facts about the request, never as an ordering. The requester set both.
    definition('Declared urgency ceiling', row.maxUrgency ?? 'not declared'),
    definition('Declared evidence level', row.evidenceLevel ?? 'not declared'),
    tallyList(row.tally),
  ];

  if (row.shortOf.length > 0) {
    children.push(text('p', `Still short of the count for ${row.shortOf.join(', ')}.`));
  }

  children.push(el('p', {}, [el('a', { href: `/requests/${row.requestId}` }, [plain('Open')])]));

  // The control is absent rather than disabled, and the reason is stated as a sentence about the
  // rule rather than about this person.
  if (row.mayNotApproveBecause !== null) {
    children.push(text('p', row.mayNotApproveBecause, { class: 'meta' }));
  }

  return el('section', { class: 'row' }, children);
}

export function queuePage(view: QueueView, shell: Omit<PageOptions, 'title' | 'current'>): string {
  const body =
    view.rows.length === 0
      ? [text('h2', 'Queue'), text('p', view.emptyMessage)]
      : [
          text('h2', 'Queue'),
          text(
            'p',
            'Oldest first. This list is never ordered by declared urgency: the requester sets ' +
              'that field, and sorting by it would let them choose how soon their own request is ' +
              'looked at.',
            { class: 'meta' },
          ),
          ...view.rows.map((row) => queueRow(row)),
        ];

  return page({ ...shell, title: 'Queue', current: 'queue' }, body);
}

// ---------------------------------------------------------------------------
// Request detail
// ---------------------------------------------------------------------------

function shadowRunSection(run: ShadowRunView | null, note: string): string {
  if (run === null) {
    return el('section', { class: 'row' }, [text('h3', 'Shadow run'), text('p', note)]);
  }

  return el('section', { class: 'row' }, [
    text('h3', 'Shadow run'),
    text('p', note, { class: 'meta' }),
    definition('Run', run.shadowRunId),
    definition(
      'Dataset',
      `${run.datasetKind}${run.datasetLabel === null ? '' : ` - ${run.datasetLabel}`}`,
    ),
    definition('Ran at', run.ranAt),
    el('table', {}, [
      el('tr', {}, [
        text('th', 'Measure', { scope: 'col' }),
        text('th', 'Count', { scope: 'col' }),
      ]),
      ...run.lines.map((line) => el('tr', {}, [text('td', line.label), text('td', line.value)])),
    ]),
    run.reasonCounts.length === 0
      ? ''
      : el('table', {}, [
          el('tr', {}, [
            text('th', 'Match reason', { scope: 'col' }),
            text('th', 'Count', { scope: 'col' }),
          ]),
          ...run.reasonCounts.map((entry) =>
            el('tr', {}, [text('td', entry.reason), text('td', String(entry.count))]),
          ),
        ]),
    text('p', `${String(run.sampleCount)} samples recorded. ${run.sampleNote}`, { class: 'meta' }),
  ]);
}

function decisionForm(requestId: string, form: DecisionFormView, token: string): string {
  const decisionFields = form.decisions.map((option) =>
    el('label', {}, [
      // No `checked` on any of them. See views.ts: a default here collects approvals from people
      // who pressed the button that was already pressed.
      el('input', { type: 'radio', name: 'decision', value: option.value, required: true }),
      plain(` ${option.text}`),
    ]),
  );

  const roleFields =
    form.roles.length === 0
      ? [
          text(
            'p',
            'This build defines no reviewer role that may judge this kind of content, so there ' +
              'is no role to record a decision as.',
          ),
        ]
      : form.roles.map((role) =>
          el('label', {}, [
            el('input', { type: 'radio', name: 'role', value: role, required: true }),
            plain(` ${role}`),
          ]),
        );

  const jurisdictionFields = form.jurisdictions.map((jurisdiction) =>
    el('label', {}, [
      el('input', { type: 'checkbox', name: 'jurisdictions', value: jurisdiction }),
      plain(` ${jurisdiction}`),
    ]),
  );

  const checklistFields = form.checklist.items.map((item) =>
    el('label', {}, [
      // `confirmed` is typed `false` and is not read here - the absence of `checked` is the
      // property, and reading a field that can only be false would suggest it might not be.
      el('input', { type: 'checkbox', name: 'checklist', value: item.item }),
      plain(` ${item.text}`),
    ]),
  );

  return el('form', { method: 'post', action: `/requests/${requestId}/decisions` }, [
    formToken(token),
    el('fieldset', {}, [text('legend', 'Decision'), ...decisionFields]),
    el('fieldset', {}, [
      text('legend', 'The role you are deciding as'),
      text(
        'p',
        'Only roles that may judge this kind of content. Spec 10 keeps regulatory interpretation ' +
          'separate from clinical safety, and a role you do not hold is refused by the database.',
        { class: 'meta' },
      ),
      ...roleFields,
    ]),
    el('fieldset', {}, [
      text('legend', 'Jurisdictions this decision covers'),
      text('p', form.note, { class: 'meta' }),
      ...jurisdictionFields,
    ]),
    el('fieldset', {}, [
      text(
        'legend',
        form.checklist.required ? 'Checklist (required for this request)' : 'Checklist (optional)',
      ),
      text('p', form.checklist.note, { class: 'meta' }),
      ...checklistFields,
    ]),
    el('label', { for: 'note' }, [plain('Note (kept with the approval, permanently)')]),
    el('textarea', { id: 'note', name: 'note', rows: 4, cols: 60 }),
    el('button', { type: 'submit' }, [plain('Record this decision')]),
  ]);
}

export function requestPage(
  view: RequestDetailView,
  form: DecisionFormView,
  shell: Omit<PageOptions, 'title' | 'current'>,
  options: {
    readonly canDecide: boolean;
    readonly message: string | null;
    readonly formToken: string;
  },
): string {
  const summary = el('section', { class: 'row' }, [
    text('h2', `${view.action} - ${view.subjectKind}`),
    definition('Request', view.requestId),
    definition('Subject', view.subjectId),
    definition('State', view.state),
    definition('Opened by', view.requestedByUserId),
    definition('Opened', `${view.requestedAt} (${view.waitingFor} ago)`),
    definition('Declared urgency ceiling', view.maxUrgency ?? 'not declared'),
    definition('Declared evidence level', view.evidenceLevel ?? 'not declared'),
    view.withdrawalReason === null ? '' : definition('Withdrawal reason', view.withdrawalReason),
    text('h3', `Approvals needed: ${String(view.requiredApprovals)} per jurisdiction`),
    tallyList(view.tally),
    view.rolesThatMayApprove.length === 0
      ? ''
      : text('p', `Roles that may approve this kind: ${view.rolesThatMayApprove.join(', ')}.`, {
          class: 'meta',
        }),
  ]);

  const approvals =
    view.approvals.length === 0
      ? el('section', { class: 'row' }, [
          text('h3', 'Decisions so far'),
          text('p', 'Nobody has recorded a decision on this request.'),
        ])
      : el('section', { class: 'row' }, [
          text('h3', 'Decisions so far'),
          text(
            'p',
            'Append-only. A recorded decision is never edited or removed, which is what makes ' +
              'this the governance audit artifact spec 10 asks for.',
            { class: 'meta' },
          ),
          el('table', {}, [
            el('tr', {}, [
              text('th', 'Reviewer', { scope: 'col' }),
              text('th', 'Role', { scope: 'col' }),
              text('th', 'Decision', { scope: 'col' }),
              text('th', 'Jurisdictions', { scope: 'col' }),
              text('th', 'When', { scope: 'col' }),
              text('th', 'Note', { scope: 'col' }),
            ]),
            ...view.approvals.map((approval) =>
              el('tr', {}, [
                text('td', approval.reviewerUserId),
                text('td', approval.role),
                text('td', approval.decision),
                text('td', approval.jurisdictions.join(', ')),
                text('td', approval.decidedAt),
                text('td', approval.note ?? ''),
              ]),
            ),
          ]),
        ]);

  const execute = view.mayExecute
    ? el('section', { class: 'row' }, [
        text('h3', view.action === 'PUBLISH' ? 'Publish' : 'Withdraw'),
        text('p', view.mayExecuteBecause),
        el('form', { method: 'post', action: `/requests/${view.requestId}/execute` }, [
          formToken(options.formToken),
          el('button', { type: 'submit' }, [
            plain(view.action === 'PUBLISH' ? 'Publish now' : 'Withdraw now'),
          ]),
        ]),
      ])
    : el('section', { class: 'row' }, [
        text('h3', view.action === 'PUBLISH' ? 'Publish' : 'Withdraw'),
        // The control is absent and the sentence says which rule removed it.
        text('p', view.mayExecuteBecause),
      ]);

  const decide = options.canDecide
    ? el('section', { class: 'row' }, [
        text('h3', 'Record a decision'),
        decisionForm(view.requestId, form, options.formToken),
      ])
    : el('section', { class: 'row' }, [
        text('h3', 'Record a decision'),
        text(
          'p',
          'You opened this request. Spec 10 keeps authoring and approving separate, so somebody ' +
            'else records the decision.',
        ),
      ]);

  const body = [
    options.message === null
      ? ''
      : el('p', { class: 'warning' }, [text('strong', options.message)]),
    summary,
    shadowRunSection(view.shadowRun, view.shadowRunNote),
    approvals,
    view.state === 'OPEN' ? decide : '',
    view.state === 'OPEN' ? execute : '',
    el('p', {}, [el('a', { href: '/queue' }, [plain('Back to the queue')])]),
  ];

  return page({ ...shell, title: 'Request' }, body);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export function operationsPage(
  view: OperationsView,
  shell: Omit<PageOptions, 'title' | 'current'>,
  options: {
    readonly publicationBlocked: boolean;
    readonly message: string | null;
    readonly formToken: string;
  },
): string {
  const metrics = el('table', {}, [
    el('tr', {}, [
      text('th', 'Metric', { scope: 'col' }),
      text('th', 'Value', { scope: 'col' }),
      text('th', 'Unit', { scope: 'col' }),
    ]),
    ...view.metrics.map((metric) =>
      el('tr', {}, [text('td', metric.key), text('td', metric.value), text('td', metric.unit)]),
    ),
  ]);

  const sources = el('table', {}, [
    el('tr', {}, [
      text('th', 'Source', { scope: 'col' }),
      text('th', 'Jurisdiction', { scope: 'col' }),
      text('th', 'Owner', { scope: 'col' }),
      text('th', 'Last successful check', { scope: 'col' }),
      text('th', 'Notes', { scope: 'col' }),
    ]),
    ...view.sources.map((source) =>
      el('tr', {}, [
        text('td', `${source.organization} - ${source.sourceName}`),
        text('td', source.jurisdiction ?? 'none'),
        text('td', source.operationalOwner ?? 'nobody named'),
        text('td', source.lastSuccessfulCheckAt ?? 'never'),
        // Facts, one per line, none of them a health verdict.
        el(
          'td',
          {},
          source.notes.length === 0
            ? [plain('Nothing to report.')]
            : source.notes.map((note) => text('div', note)),
        ),
      ]),
    ),
  ]);

  // `10` lists the emergency stop and the emergency withdrawal as two controls, and this page is
  // where an operator already is. The block asks for a reason because a block with no reason is
  // indistinguishable from a bug and is the first thing an incident review asks about.
  const block = el('section', { class: 'row' }, [
    text('h3', 'Global publication block'),
    text(
      'p',
      options.publicationBlocked ? 'Publication is blocked.' : 'Publication is not blocked.',
    ),
    text(
      'p',
      'Blocking publication never blocks a withdrawal. Spec 10 lists both as emergency controls ' +
        'and one exists to undo the other.',
      { class: 'meta' },
    ),
    options.publicationBlocked
      ? el('form', { method: 'post', action: '/publication-block' }, [
          formToken(options.formToken),
          el('input', { type: 'hidden', name: 'blocked', value: 'false' }),
          el('button', { type: 'submit' }, [plain('Lift the block')]),
        ])
      : el('form', { method: 'post', action: '/publication-block' }, [
          formToken(options.formToken),
          el('label', { for: 'reason' }, [plain('Why publication is being blocked (required)')]),
          el('input', {
            id: 'reason',
            name: 'reason',
            type: 'text',
            required: true,
            maxlength: 500,
          }),
          el('input', { type: 'hidden', name: 'blocked', value: 'true' }),
          el('button', { type: 'submit' }, [plain('Block publication')]),
        ]),
  ]);

  const body = [
    options.message === null
      ? ''
      : el('p', { class: 'warning' }, [text('strong', options.message)]),
    text('h2', 'Operations'),
    text('p', `Snapshot at ${view.at}.`, { class: 'meta' }),
    text('p', view.noVerdictNote),
    text('h3', 'Metrics'),
    metrics,
    text('h3', 'Sources'),
    sources,
    block,
  ];

  return page({ ...shell, title: 'Operations', current: 'operations' }, body);
}

// ---------------------------------------------------------------------------
// States that are not a page of content
// ---------------------------------------------------------------------------

/**
 * What the console shows when the API said no, or said nothing.
 *
 * One page for every non-`OK` outcome, because each of them is a state a reviewer is in rather
 * than an error to be logged - and because writing a bespoke page per outcome is how one of them
 * ends up saying more than the API meant to disclose. In particular `UNAVAILABLE` says only that
 * there is nothing to show: it covers a request that does not exist and a caller with no reviewer
 * row, and the API refuses to distinguish them on purpose.
 */
export function outcomePage(
  kind: 'UNAVAILABLE' | 'OFFLINE' | 'SERVER_ERROR' | 'STEP_UP_REQUIRED' | 'REFUSED',
  detail: {
    readonly message: string | null;
    readonly correlationId: string | null;
    readonly formToken: string;
  },
  shell: Omit<PageOptions, 'title' | 'current'>,
): string {
  const copy: Readonly<Record<typeof kind, { readonly title: string; readonly body: string }>> = {
    UNAVAILABLE: {
      title: 'Nothing to show',
      body:
        'There is nothing here for this session. That covers a request that does not exist and a ' +
        'session holding no reviewer role, and the API does not distinguish them.',
    },
    OFFLINE: {
      title: 'The API did not answer',
      body: 'The request did not reach the staff API. Nothing was recorded.',
    },
    SERVER_ERROR: {
      title: 'The API could not answer',
      body: 'The staff API failed to answer. Nothing here says whether the action was recorded.',
    },
    STEP_UP_REQUIRED: {
      title: 'Confirm your identity',
      body:
        'Publishing, withdrawing and changing the publication block each ask you to confirm your ' +
        'identity again. Spec 14 asks for that at the action, not once at the start of the day.',
    },
    REFUSED: {
      title: 'The API refused this',
      body: 'The staff API declined the request.',
    },
  };

  const chosen = copy[kind];
  const body = [
    text('h2', chosen.title),
    text('p', chosen.body),
    detail.message === null ? '' : text('p', detail.message),
    detail.correlationId === null
      ? ''
      : el('p', { class: 'meta' }, [plain('Correlation ID: '), text('code', detail.correlationId)]),
    kind === 'STEP_UP_REQUIRED'
      ? el('form', { method: 'post', action: '/step-up' }, [
          formToken(detail.formToken),
          el('button', { type: 'submit' }, [plain('Confirm my identity')]),
        ])
      : '',
    el('p', {}, [el('a', { href: '/queue' }, [plain('Back to the queue')])]),
  ];

  return page({ ...shell, title: chosen.title }, body);
}
