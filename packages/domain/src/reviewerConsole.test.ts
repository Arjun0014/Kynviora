import { describe, it, expect } from 'vitest';
import {
  APPROVAL_DECISIONS,
  APPROVING_ROLES,
  PUBLICATION_CHECKLIST,
  PUBLISHABLE_KINDS,
  REVIEWER_ROLES,
  checklistRequired,
  missingChecklistItems,
  evaluateApproval,
  evaluatePublication,
  mayApprove,
  publicationAuditDetail,
  requiredApprovals,
  tallyByJurisdiction,
  type ApprovalRequest,
  type PublicationRequest,
  type RecordedApproval,
  type ReviewerGrant,
} from './reviewerConsole.js';
import { ACTION_URGENCIES, EVIDENCE_LEVELS, JURISDICTIONS } from './vocabulary.js';
import { instantFrom } from './ports.js';
import { isErr, isOk } from './result.js';
import { unsafeId, type UserId } from './ids.js';

/**
 * Reviewer queue and publication controls.
 *
 * Two exit criteria. "High-impact content cannot be published by an unauthorized single path" is
 * asserted as three separate refusals - an inactive role, a role that cannot judge this kind of
 * content, and the requester approving their own work - because each one is a different way the
 * single path reappears. "Publication is attributable, reversible, and scoped to the intended
 * jurisdiction" is asserted mostly through the jurisdiction tally, which is where a two-person
 * rule quietly becomes a one-person rule for the scope nobody actually reviewed.
 */

const AUTHOR = unsafeId<UserId>('11111111-1111-4111-8111-111111111111');
const REVIEWER_ONE = unsafeId<UserId>('22222222-2222-4222-8222-222222222222');
const REVIEWER_TWO = unsafeId<UserId>('33333333-3333-4333-8333-333333333333');

const NOW = instantFrom('2026-08-29T12:00:00.000Z');

function request(overrides: Partial<PublicationRequest> = {}): PublicationRequest {
  return {
    subjectKind: 'assessment_rule_version',
    subjectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    action: 'PUBLISH',
    jurisdictions: ['GB'],
    impact: { maxUrgency: 'HIGH', evidenceLevel: 'A' },
    requestedByUserId: AUTHOR,
    state: 'OPEN',
    withdrawalReason: null,
    ...overrides,
  };
}

function reviewer(overrides: Partial<ReviewerGrant> = {}): ReviewerGrant {
  return {
    userId: REVIEWER_ONE,
    role: 'CLINICAL_SAFETY_LEAD',
    status: 'ACTIVE',
    ...overrides,
  };
}

function approvalRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    decision: 'APPROVE',
    jurisdictions: ['GB'],
    checklistConfirmed: [...PUBLICATION_CHECKLIST],
    note: null,
    ...overrides,
  };
}

function approved(
  userId: UserId,
  jurisdictions: readonly ('GB' | 'NI' | 'EU')[],
): RecordedApproval {
  return {
    reviewerUserId: userId,
    role: 'CLINICAL_SAFETY_LEAD',
    decision: 'APPROVE',
    jurisdictions,
  };
}

const EXECUTOR = { userId: REVIEWER_TWO, now: NOW, isReviewer: true };
const OPEN_ENVIRONMENT = { publicationBlocked: false };

// ---------------------------------------------------------------------------

describe('how many people a publication needs', () => {
  it('needs two for content that tells someone to act now', () => {
    for (const maxUrgency of ['CRITICAL', 'HIGH'] as const) {
      expect(requiredApprovals('PUBLISH', { maxUrgency, evidenceLevel: 'A' })).toBe(2);
    }
  });

  it('needs two for a confident next step resting on limited evidence', () => {
    // The shape a false positive takes: medium urgency wording on evidence that does not support
    // it. Spec 10 asks for exactly this definition.
    for (const evidenceLevel of ['D', 'U'] as const) {
      expect(requiredApprovals('PUBLISH', { maxUrgency: 'MEDIUM', evidenceLevel })).toBe(2);
    }
    expect(requiredApprovals('PUBLISH', { maxUrgency: 'MEDIUM', evidenceLevel: 'A' })).toBe(1);
  });

  it('needs one for low-urgency content', () => {
    for (const maxUrgency of ['LOW', 'INFORMATIONAL'] as const) {
      expect(requiredApprovals('PUBLISH', { maxUrgency, evidenceLevel: 'U' })).toBe(1);
    }
  });

  it('always needs one for a withdrawal, however urgent the content was', () => {
    // The asymmetry is deliberate. A wrongly-published alert tells a person to act; a wrongly
    // withdrawn one removes information. Making the safe direction the slow one would leave a
    // live wrong alert up while a second reviewer is found.
    for (const maxUrgency of ACTION_URGENCIES) {
      expect(requiredApprovals('WITHDRAW', { maxUrgency, evidenceLevel: 'A' })).toBe(1);
    }
  });

  it('is a count of people over the whole vocabulary, never a rating of the content', () => {
    // Guards the rule that evidence level and action urgency have no conversion between them: the
    // policy reads both and returns a number of humans, and there is no combination that yields
    // anything else.
    for (const maxUrgency of ACTION_URGENCIES) {
      for (const evidenceLevel of EVIDENCE_LEVELS) {
        expect([1, 2]).toContain(requiredApprovals('PUBLISH', { maxUrgency, evidenceLevel }));
      }
    }
  });

  it('needs two when the impact was never declared', () => {
    expect(requiredApprovals('PUBLISH', null)).toBe(2);
  });
});

describe('a role is not a generic reviewer', () => {
  it('keeps regulatory approval separate from clinical approval', () => {
    // Spec 10: regulatory comparison is a separate publication responsibility from clinical
    // safety assessment. Two approvals from people who cannot judge the content are not
    // governance, whatever the count says.
    expect(mayApprove('assessment_rule_version', 'REGULATORY_LEGAL_REVIEWER')).toBe(false);
    expect(mayApprove('regulatory_rule_version', 'CLINICAL_SAFETY_LEAD')).toBe(false);
    expect(mayApprove('regulatory_rule_version', 'REGULATORY_LEGAL_REVIEWER')).toBe(true);
  });

  it('lets the plain-language owner approve wording and nothing else', () => {
    expect(mayApprove('alert_publication', 'CONTENT_PLAIN_LANGUAGE_OWNER')).toBe(true);
    for (const kind of PUBLISHABLE_KINDS.filter((k) => k !== 'alert_publication')) {
      expect(mayApprove(kind, 'CONTENT_PLAIN_LANGUAGE_OWNER')).toBe(false);
    }
  });

  it('gives every publishable kind at least one role that can approve it', () => {
    for (const kind of PUBLISHABLE_KINDS) {
      expect(APPROVING_ROLES[kind].length).toBeGreaterThan(0);
    }
  });

  it('names only real roles in the mapping', () => {
    for (const kind of PUBLISHABLE_KINDS) {
      for (const role of APPROVING_ROLES[kind]) {
        expect(REVIEWER_ROLES).toContain(role);
      }
    }
  });
});

describe('recording one approval', () => {
  it('refuses a reviewer whose role is not active', () => {
    for (const status of ['SUSPENDED', 'REVOKED'] as const) {
      const result = evaluateApproval(request(), reviewer({ status }), approvalRequest(), {
        now: NOW,
      });
      expect(isErr(result) && result.error.detail?.reason_code).toBe('reviewer_not_active');
    }
  });

  it('refuses a role that does not review this kind of content', () => {
    const result = evaluateApproval(
      request({ subjectKind: 'regulatory_rule_version' }),
      reviewer({ role: 'MEDICATION_SAFETY_REVIEWER' }),
      approvalRequest(),
      { now: NOW },
    );
    expect(isErr(result) && result.error.detail?.reason_code).toBe('role_not_permitted_for_kind');
  });

  it('refuses the requester approving their own publication', () => {
    // Spec 10's separation of duties. This is the single path the exit criterion names, arriving
    // by the most ordinary route: the person who wrote it also signs it off.
    const result = evaluateApproval(request(), reviewer({ userId: AUTHOR }), approvalRequest(), {
      now: NOW,
    });
    expect(isErr(result) && result.error.detail?.reason_code).toBe('separation_of_duties');
  });

  it('lets the requester approve their own withdrawal', () => {
    const result = evaluateApproval(
      request({ action: 'WITHDRAW', withdrawalReason: 'Wrong batch number.' }),
      reviewer({ userId: AUTHOR }),
      approvalRequest(),
      { now: NOW },
    );
    expect(isOk(result)).toBe(true);
  });

  it('refuses an approval that reviewed nothing', () => {
    const result = evaluateApproval(request(), reviewer(), approvalRequest({ jurisdictions: [] }), {
      now: NOW,
    });
    expect(isErr(result) && result.error.detail?.reason_code).toBe('approval_needs_a_scope');
  });

  it('refuses an approval covering a jurisdiction the request does not', () => {
    // Approving NI on a GB request records a review nobody performed.
    const result = evaluateApproval(
      request({ jurisdictions: ['GB'] }),
      reviewer(),
      approvalRequest({ jurisdictions: ['GB', 'NI'] }),
      { now: NOW },
    );
    expect(isErr(result) && result.error.detail?.reason_code).toBe(
      'approval_scope_exceeds_request',
    );
  });

  it('refuses a decision on a request that is already closed', () => {
    const result = evaluateApproval(request({ state: 'EXECUTED' }), reviewer(), approvalRequest(), {
      now: NOW,
    });
    expect(isErr(result) && result.error.detail?.reason_code).toBe('request_not_open');
  });

  it('records the role the reviewer acted in', () => {
    // A person may hold two roles, and which one they were acting in is part of what makes the
    // decision attributable at all.
    const result = evaluateApproval(
      request(),
      reviewer({ role: 'PRODUCT_SAFETY_REVIEWER' }),
      approvalRequest(),
      { now: NOW },
    );
    expect(isOk(result) && result.value.role).toBe('PRODUCT_SAFETY_REVIEWER');
    expect(isOk(result) && result.value.reviewerUserId).toBe(REVIEWER_ONE);
  });

  it('accepts every decision the spec names', () => {
    expect([...APPROVAL_DECISIONS]).toEqual(['APPROVE', 'REJECT', 'RETURN_FOR_CORRECTION']);
    for (const decision of APPROVAL_DECISIONS) {
      const result = evaluateApproval(request(), reviewer(), approvalRequest({ decision }), {
        now: NOW,
      });
      expect(isOk(result)).toBe(true);
    }
  });
});

describe('counting approvals by jurisdiction', () => {
  it('counts people, not rows', () => {
    // The obvious way to satisfy a two-person rule with one person.
    const tally = tallyByJurisdiction(request({ jurisdictions: ['GB'] }), [
      approved(REVIEWER_ONE, ['GB']),
      approved(REVIEWER_ONE, ['GB']),
    ]);
    expect(tally).toEqual([{ jurisdiction: 'GB', approvals: 1 }]);
  });

  it('does not let an approval for one jurisdiction count for another', () => {
    // Spec 10 requires Great Britain and Northern Ireland to be reviewed separately.
    const tally = tallyByJurisdiction(request({ jurisdictions: ['GB', 'NI'] }), [
      approved(REVIEWER_ONE, ['GB']),
      approved(REVIEWER_TWO, ['GB']),
    ]);
    expect(tally).toEqual([
      { jurisdiction: 'GB', approvals: 2 },
      { jurisdiction: 'NI', approvals: 0 },
    ]);
  });

  it('ignores rejections when counting approvals', () => {
    const tally = tallyByJurisdiction(request(), [
      { ...approved(REVIEWER_ONE, ['GB']), decision: 'REJECT' },
    ]);
    expect(tally[0]?.approvals).toBe(0);
  });
});

describe('executing a publication', () => {
  const twoPersonRequest = request({ impact: { maxUrgency: 'CRITICAL', evidenceLevel: 'A' } });

  it('refuses one approval where two are required', () => {
    const result = evaluatePublication(
      twoPersonRequest,
      [approved(REVIEWER_ONE, ['GB'])],
      EXECUTOR,
      OPEN_ENVIRONMENT,
    );
    expect(isErr(result) && result.error.detail?.reason_code).toBe('insufficient_approvals');
    expect(isErr(result) && result.error.detail?.required).toBe(2);
  });

  it('refuses when one jurisdiction is short and the other is satisfied', () => {
    // The quiet failure: the count looks met overall, and one of the two scopes was never
    // reviewed by anyone.
    const result = evaluatePublication(
      request({
        jurisdictions: ['GB', 'NI'],
        impact: { maxUrgency: 'HIGH', evidenceLevel: 'A' },
      }),
      [approved(REVIEWER_ONE, ['GB', 'NI']), approved(REVIEWER_TWO, ['GB'])],
      EXECUTOR,
      OPEN_ENVIRONMENT,
    );
    expect(isErr(result) && result.error.detail?.short_jurisdictions).toBe('NI');
  });

  it('publishes when every jurisdiction reaches the count', () => {
    const result = evaluatePublication(
      request({
        jurisdictions: ['GB', 'NI'],
        impact: { maxUrgency: 'HIGH', evidenceLevel: 'A' },
      }),
      [approved(REVIEWER_ONE, ['GB', 'NI']), approved(REVIEWER_TWO, ['GB', 'NI'])],
      EXECUTOR,
      OPEN_ENVIRONMENT,
    );
    expect(isOk(result)).toBe(true);
    expect(isOk(result) && result.value.approvedJurisdictions).toEqual(['GB', 'NI']);
    expect(isOk(result) && result.value.requiredApprovals).toBe(2);
  });

  it('is not outvoted by later approvals after somebody asked for changes', () => {
    const result = evaluatePublication(
      twoPersonRequest,
      [
        { ...approved(REVIEWER_ONE, ['GB']), decision: 'RETURN_FOR_CORRECTION' },
        approved(REVIEWER_TWO, ['GB']),
      ],
      EXECUTOR,
      OPEN_ENVIRONMENT,
    );
    expect(isErr(result) && result.error.detail?.reason_code).toBe('outstanding_objection');
  });

  it('refuses the requester publishing their own request', () => {
    const result = evaluatePublication(
      request({ impact: { maxUrgency: 'LOW', evidenceLevel: 'A' } }),
      [approved(REVIEWER_ONE, ['GB'])],
      { userId: AUTHOR, now: NOW, isReviewer: true },
      OPEN_ENVIRONMENT,
    );
    expect(isErr(result) && result.error.detail?.reason_code).toBe('separation_of_duties');
  });

  it('refuses an executor who is not a reviewer at all', () => {
    const result = evaluatePublication(
      request({ impact: { maxUrgency: 'LOW', evidenceLevel: 'A' } }),
      [approved(REVIEWER_ONE, ['GB'])],
      { ...EXECUTOR, isReviewer: false },
      OPEN_ENVIRONMENT,
    );
    expect(isErr(result) && result.error.detail?.reason_code).toBe('executor_not_a_reviewer');
  });

  it('refuses to publish while publication is globally blocked', () => {
    const result = evaluatePublication(
      request({ impact: { maxUrgency: 'LOW', evidenceLevel: 'A' } }),
      [approved(REVIEWER_ONE, ['GB'])],
      EXECUTOR,
      { publicationBlocked: true },
    );
    expect(isErr(result) && result.error.detail?.reason_code).toBe('publication_blocked');
  });

  it('still withdraws while publication is blocked', () => {
    // Blocking publication must never block stopping something. Spec 10 lists both as emergency
    // controls, and one of them exists to undo the other.
    const result = evaluatePublication(
      request({ action: 'WITHDRAW', withdrawalReason: 'Recall applied to the wrong batch.' }),
      [approved(REVIEWER_ONE, ['GB'])],
      EXECUTOR,
      { publicationBlocked: true },
    );
    expect(isOk(result)).toBe(true);
  });

  it('lets one reviewer withdraw their own request', () => {
    const result = evaluatePublication(
      request({
        action: 'WITHDRAW',
        withdrawalReason: 'Superseded by a corrected notice.',
        requestedByUserId: REVIEWER_TWO,
      }),
      [approved(REVIEWER_ONE, ['GB'])],
      EXECUTOR,
      OPEN_ENVIRONMENT,
    );
    expect(isOk(result)).toBe(true);
  });

  it('refuses a withdrawal that does not say why', () => {
    // Spec 10 retains the correction/withdrawal reason as a governance artifact, and an
    // unexplained withdrawal is the one an incident review cannot reconstruct.
    for (const withdrawalReason of [null, '   ']) {
      const result = evaluatePublication(
        request({ action: 'WITHDRAW', withdrawalReason }),
        [approved(REVIEWER_ONE, ['GB'])],
        EXECUTOR,
        OPEN_ENVIRONMENT,
      );
      expect(isErr(result) && result.error.detail?.reason_code).toBe('withdrawal_needs_a_reason');
    }
  });

  it('refuses a request that has already been decided', () => {
    const result = evaluatePublication(
      request({ state: 'REJECTED' }),
      [approved(REVIEWER_ONE, ['GB']), approved(REVIEWER_TWO, ['GB'])],
      EXECUTOR,
      OPEN_ENVIRONMENT,
    );
    expect(isErr(result) && result.error.detail?.reason_code).toBe('request_not_open');
  });

  it('names every jurisdiction Kynviora monitors as approvable, and no others', () => {
    // Guards trap 2: GB and NI are separate by design, and no UK entry exists to collapse them.
    expect([...JURISDICTIONS]).toContain('GB');
    expect([...JURISDICTIONS]).toContain('NI');
    expect(JURISDICTIONS as readonly string[]).not.toContain('UK');
  });
});

describe('the audit detail', () => {
  it('records who and what, never the content', () => {
    const detail = publicationAuditDetail({
      action: 'PUBLISH',
      subjectKind: 'alert_publication',
      jurisdictions: ['NI', 'GB'],
      requiredApprovals: 2,
      approverCount: 2,
      hadWithdrawalReason: false,
    });
    expect(detail).toEqual({
      action: 'PUBLISH',
      subject_kind: 'alert_publication',
      jurisdictions: 'GB,NI',
      required_approvals: 2,
      approver_count: 2,
      withdrawal_reason_recorded: false,
    });
  });

  it('sorts the jurisdictions so two identical publications log identically', () => {
    const a = publicationAuditDetail({
      action: 'PUBLISH',
      subjectKind: 'assessment_rule_version',
      jurisdictions: ['GB', 'EU'],
      requiredApprovals: 1,
      approverCount: 1,
      hadWithdrawalReason: false,
    });
    const b = publicationAuditDetail({
      action: 'PUBLISH',
      subjectKind: 'assessment_rule_version',
      jurisdictions: ['EU', 'GB'],
      requiredApprovals: 1,
      approverCount: 1,
      hadWithdrawalReason: false,
    });
    expect(a).toEqual(b);
  });
});

describe("spec 10's high-severity publication checklist", () => {
  it('is required exactly where a second reviewer is', () => {
    // One threshold, not two. Content that needs a second pair of hands is content that needs the
    // ten checks; content that needs one is not high-severity by spec 10's own definition.
    expect(checklistRequired('PUBLISH', { maxUrgency: 'HIGH', evidenceLevel: 'A' })).toBe(true);
    expect(checklistRequired('PUBLISH', { maxUrgency: 'LOW', evidenceLevel: 'A' })).toBe(false);
  });

  it('is never required to withdraw something', () => {
    // The checklist is about what publishing will do to people. Stopping something does none of
    // it, and a ten-item form in front of an emergency stop is a reason it does not get used.
    expect(checklistRequired('WITHDRAW', { maxUrgency: 'CRITICAL', evidenceLevel: 'A' })).toBe(
      false,
    );
  });

  it('names every check spec 10 lists', () => {
    expect(PUBLICATION_CHECKLIST).toHaveLength(10);
    for (const item of [
      'SOURCE_AUTHENTICITY',
      'EXACT_JURISDICTION',
      'MEDICATION_BOUNDARY',
      'WITHDRAWAL_READINESS',
      'INCIDENT_OWNER',
    ] as const) {
      expect(PUBLICATION_CHECKLIST).toContain(item);
    }
  });

  it('refuses a high-severity approval that skipped a check, and says which', () => {
    const result = evaluateApproval(
      request(),
      reviewer(),
      approvalRequest({
        checklistConfirmed: PUBLICATION_CHECKLIST.filter((i) => i !== 'MEDICATION_BOUNDARY'),
      }),
      { now: NOW },
    );
    expect(isErr(result) && result.error.detail?.reason_code).toBe('checklist_incomplete');
    expect(isErr(result) && result.error.detail?.missing).toBe('MEDICATION_BOUNDARY');
  });

  it('does not ask a reviewer to vouch for content they are refusing', () => {
    // A rejection is the reviewer saying it is not ready. Demanding they first confirm ten things
    // about it would be asking them to sign off on what they are turning down.
    for (const decision of ['REJECT', 'RETURN_FOR_CORRECTION'] as const) {
      const result = evaluateApproval(
        request(),
        reviewer(),
        approvalRequest({ decision, checklistConfirmed: [] }),
        { now: NOW },
      );
      expect(isOk(result)).toBe(true);
      expect(isOk(result) && result.value.checklistConfirmed).toEqual([]);
    }
  });

  it('does not require the checklist for low-impact content', () => {
    const result = evaluateApproval(
      request({ impact: { maxUrgency: 'INFORMATIONAL', evidenceLevel: 'A' } }),
      reviewer(),
      approvalRequest({ checklistConfirmed: [] }),
      { now: NOW },
    );
    expect(isOk(result)).toBe(true);
  });

  it('reports every outstanding item, not just the first', () => {
    expect(missingChecklistItems(['SOURCE_AUTHENTICITY'])).toHaveLength(
      PUBLICATION_CHECKLIST.length - 1,
    );
    expect(missingChecklistItems([...PUBLICATION_CHECKLIST])).toEqual([]);
  });
});
