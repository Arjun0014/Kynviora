/**
 * The typed API client.
 *
 * Spec references: `13` (API contract, authorization, idempotency), `14` (deny by default),
 * `11` (server-authoritative safety), DEC-010.
 *
 * WHAT THIS CLIENT DELIBERATELY CANNOT DO
 * It transports. It does not evaluate a safety rule, decide an urgency, combine an evidence level
 * with an urgency into a severity, or choose which side of a reconciliation difference is right.
 * DEC-010 puts the rule engine server-side and says the mobile client must never gain a
 * rule-evaluation code path; `23` D-005 forbids the aggregate; Phase 8.5 forbids the third value.
 * Those are not comments here, they are the reason there is no method that would need one - a
 * client that could compute any of them would be a second source of truth on a phone, updated
 * whenever the app store says so rather than whenever a reviewer approves something.
 *
 * WHY EVERY METHOD RETURNS AN OUTCOME
 * None of these throw for a failed request. `06` requires every critical route to define its
 * offline, error and authorization-lost states, and the way to make a screen handle them is for
 * the compiler to hand it a union it has to destructure - not for a `catch` block it can forget.
 */

import type { ApiConfig, ClientSession } from './config.js';
import { request, type FetchLike, type QueryValue } from './http.js';
import type { ApiOutcome } from './outcome.js';

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------
// Mirrors of what the routes actually send. Declared rather than inferred because the API and the
// client are separate packages by design: `13` requires a stable contract, and a shape imported
// from the server would make a breaking change to it invisible until runtime.

export interface ProfileSummary {
  readonly id: string;
  readonly displayName: string;
  readonly ageBand: string | null;
  /** Whether the profile is for someone the account holder looks after. Not about authority. */
  readonly isManaged: boolean;
  /**
   * Whether this caller owns the profile.
   *
   * The signal screens gate on. Deliberately distinct from `isManaged`, which is about the person
   * the profile is for: an owner may perfectly well own a managed profile, and reading one as the
   * other produced a caregiver-invite screen that offered the wrong capabilities.
   */
  readonly isOwner: boolean;
}

export interface ProfilesResponse {
  readonly profiles: readonly ProfileSummary[];
  readonly serverTime: string;
}

export interface ShelfItem {
  readonly id: string;
  readonly profileId: string;
  readonly itemKind: 'MEDICINE' | 'PERSONAL_CARE';
  readonly displayName: string;
  readonly brand: string | null;
  readonly lifecycleState: 'ACTIVE' | 'STOPPED' | 'ARCHIVED';
  /** Three separate axes. `02` forbids collapsing them into one "verified" badge. */
  readonly identityVerification: string;
  readonly formulationVerification: string;
  readonly batchVerification: string;
  readonly lastReviewedAt: string | null;
  readonly lastSafetyCheckedAt: string | null;
  /**
   * What is not settled about this item (`04` Phase 2.1).
   *
   * On every row rather than behind the filter: the exit criterion is that a person *can
   * understand* which items need something, and a list where that is visible only to somebody who
   * already knew to filter for it does not meet it.
   */
  readonly attentionReasons: readonly string[];
}

export interface ItemFieldResponse {
  readonly label: string;
  readonly value: string | null;
  readonly absentNote: string | null;
  /** True for text somebody else wrote - written directions, and the household's own notes. */
  readonly quoted: boolean;
}

/**
 * One item, composed on the server (`04` Phase 2.1).
 *
 * The category fields differ by category and the group the other category has is absent rather
 * than empty, which is exit criterion 1 in the shape of the response.
 */
export interface ItemDetailResponse {
  readonly id: string;
  readonly displayName: string;
  readonly brand: string | null;
  readonly itemKind: 'MEDICINE' | 'PERSONAL_CARE';
  readonly lifecycleState: string;
  readonly lifecycleNote: string | null;
  readonly identity: StatusPresentationResponse;
  readonly formulation: StatusPresentationResponse;
  readonly batch: StatusPresentationResponse;
  readonly verificationNote: string;
  readonly categoryHeading: string;
  readonly categoryFields: readonly ItemFieldResponse[];
  readonly sharedFields: readonly ItemFieldResponse[];
  readonly attention: {
    readonly reasons: readonly {
      readonly reason: string;
      readonly label: string;
      readonly nextStep: string;
    }[];
    readonly undescribedCount: number;
    readonly undescribedNote: string | null;
    readonly settledNote: string | null;
  };
  readonly attentionReasonCodes: readonly string[];
  /**
   * The version this detail was read at.
   *
   * Sent back on a change. `13` sets `owned_item`'s conflict policy to `ASK_USER`, so an edit
   * that did not say what it was editing could only be last-write-wins.
   */
  readonly version: number;
  /**
   * Whether this caller may change it.
   *
   * Evaluated on the server with the same expression the update policy uses, so the screen and
   * the policy cannot disagree. A screen withholds the controls rather than offering ones the
   * write would refuse - absent rather than disabled, as DEC-045 has it.
   */
  readonly mayEdit: boolean;
  /**
   * The stored values, keyed as the manual-entry form keys them.
   *
   * Separate from `categoryFields` and `sharedFields`, which are presentation. An editor cannot
   * use a rendered label - matching on one would be the "branch on message text" `13` forbids -
   * and a form needs the field's own name to send it back.
   */
  readonly editableValues: Readonly<Record<string, string | null>>;
  readonly stoppedOn: string | null;
  readonly serverTime: string;
}

export interface ItemsResponse {
  readonly items: readonly ShelfItem[];
  readonly nextCursor: string | null;
  readonly serverTime: string;
}

/**
 * What somebody typed about a pack they are holding (`04` Phases 2.2 and 2.3).
 *
 * Only `profileId`, `itemKind` and `displayName` are required, which is Phase 2.2's first exit
 * criterion on the wire: a record has to be creatable from a name and nothing else.
 *
 * There is deliberately no field for a verification state, a confidence, or a catalog identifier.
 * Their absence is the enforcement, and the server's body schema is `.strict()`, so an attempt to
 * send one is a refusal rather than a key that is quietly ignored - a client that believed it had
 * confirmed something would be the worst version of this.
 */
export interface ManualEntryBody {
  readonly profileId: string;
  readonly itemKind: 'MEDICINE' | 'PERSONAL_CARE';
  readonly displayName: string;
  readonly brand?: string | null;
  readonly manufacturer?: string | null;
  readonly market?: string | null;
  readonly recordedGtin?: string | null;
  readonly recordedLotCode?: string | null;
  readonly expiresOn?: string | null;
  readonly startedOn?: string | null;
  readonly notes?: string | null;
  readonly strengthText?: string | null;
  readonly dosageForm?: string | null;
  readonly directionsText?: string | null;
  readonly personalCareCategory?: string | null;
  readonly ingredientDeclarationRaw?: string | null;
  readonly labelVersionNote?: string | null;
}

/**
 * What exists afterwards, and what it cannot do yet.
 *
 * The limits are composed on the server for `11`'s reason: they are the approved wording for what
 * Kynviora will not be able to do about this pack, and a client that assembled them would carry
 * that copy in every build it ever shipped. `limitCodes` is beside them so a client can act on
 * the identity rather than by matching a sentence.
 *
 * `replayed` says the save arrived twice and one item exists. Reported rather than hidden,
 * because a client that has lost its own record of the first attempt otherwise cannot tell a
 * commit from a duplicate - but it is not a different outcome for the person, and no screen here
 * says anything different about it.
 */
export interface ItemCreated {
  readonly id: string;
  readonly heading: string;
  readonly limits: readonly string[];
  readonly limitCodes: readonly string[];
  readonly completeNote: string | null;
  readonly note: string;
  readonly replayed: boolean;
  readonly serverTime: string;
}

/**
 * A change to an item that already exists (`04` Stage 2 - update, archive, review).
 *
 * Absent means unchanged and `null` means cleared - collapsing them would mean either that
 * nothing can ever be un-entered, or that every save wipes every field the screen did not happen
 * to send.
 *
 * There is no field for a verification state, a catalog identifier, an item kind or a
 * `lastReviewedAt`: editing a record is not evidence about a pack, and `markReviewed` is a
 * request the server timestamps rather than a time a client supplies.
 */
export interface ItemUpdateBody {
  readonly expectedVersion: number;
  readonly displayName?: string;
  readonly brand?: string | null;
  readonly manufacturer?: string | null;
  readonly market?: string | null;
  readonly recordedGtin?: string | null;
  readonly recordedLotCode?: string | null;
  readonly expiresOn?: string | null;
  readonly startedOn?: string | null;
  readonly notes?: string | null;
  readonly strengthText?: string | null;
  readonly dosageForm?: string | null;
  readonly directionsText?: string | null;
  readonly personalCareCategory?: string | null;
  readonly ingredientDeclarationRaw?: string | null;
  readonly labelVersionNote?: string | null;
  readonly lifecycleState?: string;
  readonly stoppedOn?: string | null;
  readonly markReviewed?: boolean;
}

export interface ItemUpdated {
  readonly id: string;
  readonly version: number;
  readonly lifecycleState: string;
  /** Field names, never values. `14` keeps a medicine record's content out of a log. */
  readonly changedFields: readonly string[];
  readonly lastReviewedAt: string | null;
  readonly serverTime: string;
}

export interface AlertSummary {
  readonly id: string;
  readonly profileId: string;
  readonly ownedItemId: string;
  readonly publishedAt: string;
  /** Separate fields, never combined into a severity by the API or by this client (`23` D-005). */
  readonly urgency: string;
  readonly evidenceLevel: string;
  readonly matchConfidence: string;
  readonly explanationTemplateId: string;
}

export interface AlertsResponse {
  readonly alerts: readonly AlertSummary[];
  readonly serverTime: string;
}

/**
 * One item on the shelf, and what Kynviora can say about it.
 *
 * `urgency` and `evidenceLevel` are separate fields and are `null` together, because a line with
 * no live alert has neither. `23` D-005 forbids combining them and Phase 7.1 requires them to be
 * visibly separate; a response carrying one merged value would make that impossible to honour.
 */
export interface SafetyInboxLineResponse {
  readonly ownedItemId: string;
  readonly displayName: string;
  /**
   * The live alert behind this line, or `null`.
   *
   * `null` on every line whose state came from an assessment rather than a publication, which is
   * most of them. A screen opens the Phase 7.3 detail from this and offers no control where it is
   * absent - absent rather than disabled, as DEC-045 has it.
   */
  readonly alertPublicationId: string | null;
  readonly state: string;
  readonly urgency: string | null;
  readonly evidenceLevel: string | null;
  /** When Kynviora last assessed this item, or `null` for never. The absence is the point. */
  readonly lastAssessedAt: string | null;
  /**
   * Substances the Global Regulatory Lens can be asked about for this item.
   *
   * Only ingredients whose mapping to a canonical concept is exact. An ambiguous one would send
   * the Lens a substance nobody confirmed is in the pack, and the Lens answers about whatever it
   * is given. Empty until guided capture lands (`DEV-024`, `BLK-007`), which is why a screen must
   * offer no control rather than an empty one.
   */
  readonly substances: readonly {
    readonly substanceKey: string;
    readonly preferredName: string;
    /** Recorded only where the package actually discloses it. `null` is the common case (`09`). */
    readonly disclosedConcentrationPercent: number | null;
  }[];
}

/**
 * One alert, as the server composed it.
 *
 * The narrative, the withheld-reference decision and the known-versus-inferred labelling are all
 * server-side: `11` puts safety composition there, and a client that assembled any of them would
 * carry the approved wording in every build that ever shipped. This client narrows and renders;
 * it decides nothing.
 */
/**
 * A status presentation on the wire.
 *
 * Declared here rather than imported from `@kynviora/presentation`, like every other wire shape
 * in this file: the API and the client are separate packages by design, and a shape imported from
 * the server would make a breaking change to it invisible until runtime. The fields are strings
 * because that is what arrives; the view narrows them.
 */
export interface StatusPresentationResponse {
  readonly label: string;
  readonly iconName: string;
  readonly tone: string;
  readonly description: string;
  readonly accessibilityLabel: string;
}

export interface AlertFactResponse {
  readonly label: string;
  readonly value: string | null;
  readonly basis: string;
  readonly basisText: string;
}

export interface AlertDetailResponse {
  readonly alertPublicationId: string;
  readonly profileId: string;
  readonly ownedItemId: string;
  readonly isLive: boolean;
  readonly withdrawnNotice: string | null;
  /** The eight approved parts in order, or `null` where no approved wording applies. */
  readonly message: readonly string[] | null;
  readonly unexplainable: { readonly heading: string; readonly body: string } | null;
  readonly withheldNotice: string | null;
  /** Three separate presentations. Never merged (`23` D-005). */
  readonly urgency: StatusPresentationResponse;
  readonly evidence: StatusPresentationResponse;
  readonly matchConfidence: StatusPresentationResponse;
  readonly facts: readonly AlertFactResponse[];
  readonly reasons: {
    readonly reasons: readonly string[];
    readonly undescribedCount: number;
    readonly undescribedNote: string | null;
  };
  readonly source: {
    readonly organization: string | null;
    readonly sourceName: string | null;
    readonly jurisdiction: string | null;
    readonly reference: string | null;
    readonly referenceWithheldBecause: string | null;
    readonly publishedOn: string | null;
    readonly effectiveFrom: string | null;
    readonly attribution: string | null;
    readonly summary: string;
  };
  readonly coverageStatement: string;
  readonly inferredCount: number;
  readonly basisNote: string;
  readonly actions: readonly {
    readonly action: string;
    readonly label: string;
    readonly explanation: string;
  }[];
  readonly actionsUnavailableBecause: string | null;
  readonly publishedAt: string;
  readonly serverTime: string;
}

export interface IncorrectMatchReported {
  readonly recorded: boolean;
  /** True on a repeat. Said rather than pretended, so a screen does not claim a second report. */
  readonly alreadyReported: boolean;
  readonly serverTime: string;
}

export interface ReceiptEntryResponse {
  readonly label: string;
  readonly description: string;
  readonly recordedAt: string;
  readonly note: string | null;
}

export interface ReceiptHistoryResponse {
  readonly label: string;
  readonly recordedAt: string;
  readonly replacedPreviousNote: string | null;
}

export interface ReceiptBasisResponse {
  readonly heading: string;
  readonly assessedOn: string;
  readonly alertRaisedOn: string;
  /** `null` where the rule behind this alert is no longer published. The identifier survives. */
  readonly rule: string | null;
  readonly ruleUnavailableNote: string | null;
  readonly ruleVersionId: string;
  readonly regulatoryRuleVersionId: string | null;
  readonly evidenceLabel: string;
  readonly evidenceDescription: string;
  readonly urgencyLabel: string;
  readonly confidenceLabel: string;
  readonly confidenceDescription: string;
  readonly normalizationVersion: string;
  readonly note: string;
}

export interface ReceiptCorrectionResponse {
  readonly heading: string;
  readonly reason: string;
  readonly recordedAt: string;
  readonly reviewerId: string | null;
}

/**
 * The Safety Receipt (`04` Phase 7.6).
 *
 * Composed on the server like the alert detail, for the same reason: the licence gate on a source
 * reference is a `25` obligation, and a client trusted to hide a value it was sent is not a gate.
 * There is no actor on any row here, and that is deliberate (DEC-076).
 */
export interface SafetyReceiptResponse {
  readonly alertPublicationId: string;
  readonly assessmentId: string;
  /** What stands, as a code. `null` where the person has recorded nothing. */
  readonly currentResolution: string | null;
  readonly current: ReceiptEntryResponse | null;
  readonly undescribedResolutionNote: string | null;
  readonly history: readonly ReceiptHistoryResponse[];
  readonly undescribedHistoryCount: number;
  readonly basis: ReceiptBasisResponse;
  readonly source: AlertDetailResponse['source'];
  readonly corrections: readonly ReceiptCorrectionResponse[];
  readonly correctedSinceNotice: string | null;
  /** What this receipt does not settle, as sentences. Empty is a legitimate answer. */
  readonly uncertainties: readonly string[];
  /** The same list as codes, so a client can reason about them without parsing prose. */
  readonly uncertaintyCodes: readonly string[];
  readonly emptyMessage: string;
  readonly permanenceNote: string;
  readonly serverTime: string;
}

export interface ResolutionRecorded {
  readonly recorded: boolean;
  /** True where the same resolution already stood. Nothing was written. */
  readonly alreadyRecorded: boolean;
  /** True where a different resolution stood and this replaced it. */
  readonly replaced: boolean;
  readonly serverTime: string;
}

export interface SafetyInboxResponse {
  readonly profileId: string;
  readonly lines: readonly SafetyInboxLineResponse[];
  /**
   * How many items the shelf holds before filtering.
   *
   * Not a count of anything urgent. `02` refuses the badge; this exists so a filtered screen can
   * say what it is a subset of rather than looking like the whole shelf.
   */
  readonly totalItems: number;
  readonly serverTime: string;
}

export interface ProfileAlertLine {
  readonly alertId: string;
  readonly state: string;
  readonly publishedAt: string;
  readonly itemDisplayName: string;
  readonly resolution: string | null;
  readonly resolvedAt: string | null;
  readonly resolutionNote: string | null;
  /** True where a note exists and this caller may not read it (`16`). Not the same as no note. */
  readonly resolutionNoteWithheld: boolean;
}

export interface ProfileAlertsResponse {
  readonly profileId: string;
  readonly relationship: 'OWNER' | 'CAREGIVER';
  readonly alerts: readonly ProfileAlertLine[];
  readonly serverTime: string;
}

export type NotificationDetailLevel = string;

export interface NotificationSettingsResponse {
  readonly profileId: string;
  readonly relationship: 'OWNER' | 'CAREGIVER';
  readonly maxCaregiverDetail: NotificationDetailLevel;
  /** `null` means never chosen, which is not the same as having chosen the default. */
  readonly myPreference: NotificationDetailLevel | null;
  readonly effectiveDetail: NotificationDetailLevel;
  readonly cappedByOwner: boolean;
  readonly levels: readonly NotificationDetailLevel[];
  readonly serverTime: string;
}

export interface ReviewTask {
  readonly taskId: string;
  readonly kind: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly subjectLabel: string;
  readonly createdAt: string;
}

export interface ReviewTasksResponse {
  readonly profileId: string;
  /** No urgency, evidence level, severity or count of "critical" anything. Phase 8.3's criterion. */
  readonly tasks: readonly ReviewTask[];
  readonly serverTime: string;
}

export interface CaregiverGrant {
  readonly id: string;
  readonly profileId: string;
  readonly granteeUserId: string;
  readonly grantedByUserId: string;
  readonly capabilities: readonly string[];
  readonly status: string;
  readonly invitedAt: string;
  readonly acceptedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  /**
   * Whether this grant is the caller's own.
   *
   * Answered by the server, like `isOwner` on a profile (DEC-047), rather than worked out here by
   * comparing the grantee against an identity read out of the session. Removing your own access
   * and removing somebody else's are different sentences on the confirmation, and an
   * administering caregiver sees both kinds of row in one list.
   */
  readonly isSelf: boolean;
}

export interface CaregiverGrantsResponse {
  readonly grants: readonly CaregiverGrant[];
  readonly serverTime: string;
}

export interface PendingInvitation {
  readonly id: string;
  readonly profileId: string;
  readonly invitedByUserId: string;
  readonly capabilities: readonly string[];
  readonly status: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly grantExpiresAt: string | null;
  /** Whether the link is bound to one address. Never the address itself (`14`). */
  readonly boundToAddress: boolean;
}

export interface InvitationsResponse {
  readonly invitations: readonly PendingInvitation[];
  readonly serverTime: string;
}

/**
 * What removing a caregiver's access returns.
 *
 * `alreadyRevoked` is not an error. Someone removing another person's access who is answered with
 * a failure has been given a reason to doubt whether it worked, so a repeat succeeds and reports
 * that there was nothing left to do - which is a different sentence, not a different outcome.
 */
export interface GrantRevoked {
  readonly status: string;
  readonly alreadyRevoked: boolean;
  readonly serverTime: string;
}

/** What withdrawing an unaccepted invitation returns. There is no already-revoked case: the
 * server's update is conditional on the invitation still being pending, and an accepted one is
 * refused with `INVITATION_ALREADY_RESOLVED` rather than quietly succeeding. */
export interface InvitationRevoked {
  readonly status: string;
  readonly serverTime: string;
}

/**
 * One line of the access history.
 *
 * `20` requires an audit log to answer who performed a sensitive action, and forbids it becoming
 * a verbose copy of health content. `detail` is therefore scalars only - capability codes, counts
 * and booleans - and carries no name, address or token.
 */
export interface CaregiverAuditEvent {
  readonly id: string;
  readonly occurredAt: string;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly targetKind: string;
  readonly targetId: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface CaregiverAuditResponse {
  readonly events: readonly CaregiverAuditEvent[];
  readonly serverTime: string;
}

export interface DoseEventRecord {
  readonly id: string;
  readonly ownedItemId: string;
  readonly scheduleId: string | null;
  readonly eventKind: string;
  /** The dose this was recorded against, where there was one. Not every event has a schedule. */
  readonly scheduledFor: string | null;
  readonly recordedAt: string;
  /** The person's own words. Never rewritten, summarised or scored. */
  readonly note: string | null;
}

/**
 * What was recorded for one medicine.
 *
 * No count, no rate, no streak and no total. `02` lists gamified adherence scoring as an
 * anti-feature and `23` D-005 forbids the aggregate; a `takenCount` here would hand a screen
 * everything it needs to draw a scorecard, which is where nobody would notice it had appeared.
 */
export interface DoseEventsResponse {
  readonly ownedItemId: string;
  readonly events: readonly DoseEventRecord[];
  readonly serverTime: string;
}

export interface VisitPackCandidate {
  readonly section: string;
  readonly entityKind: string;
  readonly entityId: string;
  readonly version: number;
  readonly lines: readonly string[];
  readonly caveat: string | null;
}

export interface VisitPackCandidatesResponse {
  readonly profileId: string;
  readonly sections: readonly string[];
  readonly candidates: readonly VisitPackCandidate[];
  readonly availableDigest: string;
  readonly serverTime: string;
}

export interface MedicationLine {
  /** How this line is identified within the list. Stable across a retry of the same intent. */
  readonly matchKey: string;
  readonly displayName: string;
  readonly strengthText?: string | null;
  readonly dosageForm?: string | null;
  /**
   * Reproduced verbatim.
   *
   * `04` Phase 4.1 forbids rewriting a prescription instruction, so nothing on this path trims,
   * normalises or sentence-cases it.
   */
  readonly directionsText?: string | null;
}

export interface StartReconciliation {
  readonly profileId: string;
  readonly sourceKind?: 'VISIT' | 'DISCHARGE' | 'PHARMACY' | 'OTHER';
  readonly sourceNote?: string;
  /** The list the person is holding. Kynviora has no other source for it. */
  readonly currentList: readonly MedicationLine[];
}

/**
 * What starting a reconciliation returns.
 *
 * Just the ID: the differences are read back with {@link KynvioraClient.reconciliation}, because
 * the derivation is the server's and the caller must see what it actually produced rather than a
 * copy assembled on the way out.
 */
export interface ReconciliationStarted {
  readonly reconciliationId: string;
  readonly profileId: string;
  readonly serverTime: string;
}

export interface ReconciliationDifference {
  readonly differenceId: string;
  readonly kind: string;
  readonly displayName: string;
  readonly ownedItemId: string | null;
  readonly field: string | null;
  /**
   * Both sides, and nothing naming a preferred one.
   *
   * There is no third value here and there must not be. Phase 8.5's exit criterion is that
   * Kynviora never chooses which conflicting instruction is medically correct, and a
   * `suggestedValue` on this interface would be that choice (trap 19).
   */
  readonly previousValue: string | null;
  readonly currentValue: string | null;
  readonly resolution: string | null;
  readonly adoptedSide: string | null;
  readonly confirmedBy: string | null;
  readonly note: string | null;
  readonly resolvedAt: string | null;
}

export interface ReconciliationResponse {
  readonly reconciliationId: string;
  readonly profileId: string;
  readonly state: string;
  readonly sourceKind: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly unresolvedCount: number | null;
  readonly differences: readonly ReconciliationDifference[];
  readonly serverTime: string;
}

/**
 * One jurisdiction's answer, as the wire carries it.
 *
 * Declared rather than imported from `@kynviora/regulatory`, for the same reason every other
 * response shape here is: `13` requires a stable contract, and a shape imported from the producing
 * package would make a breaking change to it invisible until runtime.
 *
 * `statuses` is a list and stays one. `07` forbids collapsing several applicable statuses into a
 * single verdict, and a screen handed one string could not have shown two.
 */
export interface LensEntryResponse {
  readonly jurisdiction: string;
  readonly statuses: readonly string[];
  /** A separate axis from status (DEC-007). There is no `NON_COMPLIANT` outcome anywhere. */
  readonly applicability: string;
  readonly conditions: Readonly<Record<string, unknown>> | null;
  /** The exact conditions that could not be evaluated, so a screen can ask for the right datum. */
  readonly unresolvedConditions: readonly string[];
  readonly authority: string | null;
  readonly legalInstrument: string | null;
  readonly legalReference: string | null;
  readonly publicationDate: string | null;
  readonly effectiveDate: string | null;
  readonly lastVerifiedAt: string | null;
  /** `09` requires this alongside an absence. Never omitted, never inferred from an empty list. */
  readonly coverageStatement: string;
  /** What the entry does not mean. `09` requires every displayed status to carry its limits. */
  readonly limitations: readonly string[];
  /** Kept separate from law (`09`). An opinion is not a legal status however authoritative. */
  readonly scientificOpinions: readonly {
    readonly committee: string;
    readonly reference: string;
    readonly summary: string;
    readonly publicationDate: string | null;
    readonly hasImplementingLaw: boolean;
  }[];
  readonly productActions: readonly {
    readonly actionKind: string;
    readonly authority: string;
    readonly summary: string;
    readonly effectiveDate: string | null;
  }[];
  readonly ruleVersionId: string | null;
}

export interface LensSnapshotResponse {
  readonly substanceCanonicalKey: string;
  readonly entries: readonly LensEntryResponse[];
  readonly generatedAt: string;
  /** Requested jurisdictions Kynviora does not monitor at all. Reported, never quietly omitted. */
  readonly unmonitoredJurisdictions: readonly string[];
}

export interface LensResponse {
  readonly lens: LensSnapshotResponse;
  readonly serverTime: string;
}

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

export interface ItemsQuery {
  readonly profileId: string;
  readonly itemKind?: 'MEDICINE' | 'PERSONAL_CARE';
  readonly lifecycleState?: 'ACTIVE' | 'STOPPED' | 'ARCHIVED';
  /** Any facet in this state (`04` Phase 2.1). The three axes are not merged (`08`). */
  readonly verification?: 'CONFIRMED' | 'PROBABLE' | 'PARTIAL' | 'CONFLICTING' | 'UNVERIFIED';
  /** Items with something outstanding. A filter, never a ranking or a count. */
  readonly attention?: 'NEEDS_VERIFICATION' | 'NEEDS_REVIEW' | 'ANY';
  readonly cursor?: string;
  readonly limit?: number;
}

export interface DoseEventBody {
  readonly ownedItemId: string;
  readonly eventKind: 'TAKEN' | 'SKIPPED' | 'SNOOZED' | 'UNABLE_TO_TAKE';
  readonly scheduledFor?: string;
  readonly scheduleId?: string;
  readonly note?: string;
}

export interface ReviewTaskCompletion {
  readonly outcome: string;
  readonly changes: readonly {
    readonly recordKind: string;
    readonly recordId: string;
    readonly field: string;
    readonly value: string | null;
  }[];
}

export interface DifferenceResolution {
  readonly resolution: string;
  /**
   * Which value now stands, stated by a person.
   *
   * Never inferred from recency and never defaulted. DEC-030: a professional confirmation carries
   * no side of its own, because a pharmacist may confirm the older dose, so the screen has to ask.
   */
  readonly adopt?: string | null;
  readonly confirmedBy?: string | null;
  readonly note?: string | null;
}

export interface InvitationRequest {
  readonly profileId: string;
  readonly capabilities: readonly string[];
  /**
   * Bind the invitation to one verified address, or omit for a link anyone holding it may redeem.
   *
   * In the body only. `14` treats an address as personal data and `13` forbids sensitive data in a
   * query string; `buildUrl` refuses one anyway, but the shape of this request is what keeps it
   * out in the first place.
   */
  readonly invitedEmail?: string;
  readonly invitationTtlDays?: number;
  readonly grantExpiresAt?: string;
}

export interface InvitationCreated {
  readonly invitationId: string;
  /**
   * The live credential, emitted exactly once.
   *
   * Unrecoverable afterwards - the server stores only a SHA-256 hash (DEC-018), so an idempotent
   * retry cannot re-issue it and says so. It must never reach a URL, a log line or an exception
   * message (trap 11). Nothing in this client passes it anywhere.
   */
  readonly token: string;
  readonly expiresAt: string;
  readonly capabilities: readonly string[];
  readonly serverTime: string;
}

export interface VisitPackGeneration {
  readonly profileId: string;
  readonly selectedEntityIds: readonly string[];
  /** The digest of exactly what the user reviewed. DEC-023 refuses generation if it has moved. */
  readonly reviewedDigest: string;
  readonly reviewedAt: string;
  readonly notes?: readonly string[];
  readonly ttlHours?: number;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ClientOptions {
  readonly config: ApiConfig;
  readonly session: ClientSession;
  readonly fetch?: FetchLike;
}

export interface KynvioraClient {
  readonly session: ClientSession;

  health(): Promise<ApiOutcome<{ status: string }>>;

  listProfiles(): Promise<ApiOutcome<ProfilesResponse>>;
  listItems(query: ItemsQuery): Promise<ApiOutcome<ItemsResponse>>;
  /** One item and what is not settled about it (`04` Phase 2.1). */
  itemDetail(itemId: string): Promise<ApiOutcome<ItemDetailResponse>>;
  /**
   * Write down a pack somebody is holding (`04` Phases 2.2 and 2.3).
   *
   * The idempotency key is a parameter for the reason it is on a dose event and on an invitation:
   * a key regenerated on retry is not an idempotency key. Here it is the difference between a
   * person on a bad connection tapping Save twice and a shelf carrying two of the same medicine -
   * which `04` Phase 8.5 later reconciles against a list somebody was handed, where it reads as
   * two medicines they are taking.
   *
   * Nothing here reaches the catalog and nothing here is confirmed. Both are properties of the
   * body's shape rather than of this comment: there is no field for either.
   */
  createItem(body: ManualEntryBody, idempotencyKey: string): Promise<ApiOutcome<ItemCreated>>;
  /**
   * Change an item that already exists (`04` Stage 2 - update, archive, review).
   *
   * No idempotency key, and that is not an omission. The write is conditional on
   * `expectedVersion`, so a retry either lands once or comes back as a conflict - the same
   * guarantee a key gives, from the mechanism `13`'s `ASK_USER` policy already required. A second
   * key would be a second answer to the same question.
   */
  updateItem(itemId: string, body: ItemUpdateBody): Promise<ApiOutcome<ItemUpdated>>;
  listAlerts(): Promise<ApiOutcome<AlertsResponse>>;
  /**
   * How supported jurisdictions treat one substance.
   *
   * Beside the safety state, never substituted for it (`09`). A regulatory status is a statement
   * about the law in a place; a safety state is a statement about this person's item, and the two
   * answer different questions.
   */
  regulatoryLens(query: {
    readonly substanceKey: string;
    readonly productUseType?: string;
    readonly disclosedConcentrationPercent?: number;
    readonly intendedForAgeYears?: number;
  }): Promise<ApiOutcome<LensResponse>>;

  recordDoseEvent(
    body: DoseEventBody,
    idempotencyKey: string,
  ): Promise<ApiOutcome<{ id: string | null; serverTime: string }>>;

  /**
   * What has been recorded for one medicine, newest first.
   *
   * The item ID narrows; `dose_event_select` decides. An item this caller cannot reach comes back
   * as an empty list rather than a refusal, exactly as the shelf does - so the route is not an
   * existence oracle for an owned item ID.
   */
  doseEvents(query: {
    readonly ownedItemId: string;
    readonly limit?: number;
  }): Promise<ApiOutcome<DoseEventsResponse>>;

  listCaregiverGrants(query?: {
    readonly profileId?: string;
  }): Promise<ApiOutcome<CaregiverGrantsResponse>>;

  /**
   * Create an invitation.
   *
   * Requires step-up (`14`), which is why the session carries it rather than this method - a
   * caller that could pass "yes I am sure" here would be asserting the thing step-up exists to
   * prove. The idempotency key is a parameter for the same reason it is on a dose event: a key
   * regenerated on retry would mint a second live token for one intent, which is two credentials
   * where the owner believes there is one.
   */
  createInvitation(
    body: InvitationRequest,
    idempotencyKey: string,
  ): Promise<ApiOutcome<InvitationCreated>>;

  /**
   * Invitations nobody has accepted yet.
   *
   * Separate from `listCaregiverGrants` because they are separate records: a grant does not exist
   * until acceptance. The Care screen shows both, so an owner who has just sent an invitation can
   * see it and does not send a second.
   */
  listInvitations(query?: {
    readonly profileId?: string;
  }): Promise<ApiOutcome<InvitationsResponse>>;

  /**
   * Remove a caregiver's access, immediately.
   *
   * Requires step-up (`14`) and takes no idempotency key, which is the difference between this
   * and creating an invitation: creation mints a credential and a repeated key would mint a
   * second, whereas revocation has one destination state and arriving at it twice is arriving at
   * it once. `15` A2 makes the effect immediate - the server re-evaluates the grant on every
   * request, so nothing here has a cache to purge or a session to refresh.
   *
   * Never applied locally. `12` forbids the client holding authorization logic, and a row removed
   * before the server agreed is a false statement about who can read a person's health data.
   */
  revokeGrant(grantId: string): Promise<ApiOutcome<GrantRevoked>>;

  /**
   * Withdraw an invitation nobody has accepted.
   *
   * A separate record and a separate route from a grant, because they are separate things: the
   * invitation is a live token and the grant is the access it becomes. Withdrawing an accepted
   * invitation is refused - the access now lives in the grant, and closing the invitation would
   * be theatre.
   */
  revokeInvitation(invitationId: string): Promise<ApiOutcome<InvitationRevoked>>;

  /**
   * The access history for a profile.
   *
   * `03` group H requires audit event visibility and `06` Journey 6 step 5 requires the owner to
   * see that access changed. Read through the API rather than derived from the list, because a
   * removed grant leaves the list and the record of its removal is the thing the owner is looking
   * for afterwards.
   */
  caregiverAudit(profileId: string): Promise<ApiOutcome<CaregiverAuditResponse>>;

  /**
   * Every item on a profile's shelf with its safety state.
   *
   * Distinct from {@link KynvioraClient.listAlerts}, which lists alerts: an item with no alert is
   * absent from that and present here, saying which of "checked, nothing matched" and "never
   * checked" it is. `23` D-014 is about an absence rendering as approval, and an omission is the
   * quietest way to do it.
   */
  safetyInbox(
    profileId: string,
    filter?: { readonly states?: readonly string[]; readonly urgencies?: readonly string[] },
  ): Promise<ApiOutcome<SafetyInboxResponse>>;

  profileAlerts(profileId: string): Promise<ApiOutcome<ProfileAlertsResponse>>;
  /** One alert and everything it rests on (`04` Phase 7.3). */
  alertDetail(alertId: string): Promise<ApiOutcome<AlertDetailResponse>>;
  /**
   * Tell Kynviora a match is wrong.
   *
   * Feedback, not a resolution: it records that a person disagrees, and changes neither the alert
   * nor the assessment. Withdrawing one is a reviewer's decision through the staff console.
   */
  reportIncorrectMatch(
    alertId: string,
    body?: { readonly note?: string },
  ): Promise<ApiOutcome<IncorrectMatchReported>>;
  /** Everything recorded about one alert, and everything that changed since (`04` Phase 7.6). */
  safetyReceipt(alertId: string): Promise<ApiOutcome<SafetyReceiptResponse>>;
  /**
   * Record what a person did about an alert.
   *
   * A record, not a state change: it writes one row and alters neither the alert nor the
   * assessment behind it. There is one receipt per alert, so this replaces what stood rather than
   * adding to it - the chain of what was recorded is on the receipt read (DEC-075).
   */
  recordResolution(
    alertId: string,
    body: { readonly resolution: string; readonly note?: string },
  ): Promise<ApiOutcome<ResolutionRecorded>>;
  notificationSettings(profileId: string): Promise<ApiOutcome<NotificationSettingsResponse>>;
  setNotificationPreference(
    profileId: string,
    detailLevel: string,
  ): Promise<ApiOutcome<Record<string, unknown>>>;
  setNotificationPolicy(
    profileId: string,
    maxCaregiverDetail: string,
  ): Promise<ApiOutcome<Record<string, unknown>>>;

  reviewTasks(profileId: string): Promise<ApiOutcome<ReviewTasksResponse>>;
  completeReviewTask(
    taskId: string,
    completion: ReviewTaskCompletion,
  ): Promise<ApiOutcome<Record<string, unknown>>>;

  visitPackCandidates(profileId: string): Promise<ApiOutcome<VisitPackCandidatesResponse>>;
  /**
   * Generate a pack.
   *
   * Requires step-up (`14`) and an idempotency key (`13`). The key is a parameter for the same
   * reason it is on an invitation: regenerated on retry it would produce a second export of the
   * same content, each with its own retrieval URL and its own expiry.
   */
  createVisitPack(
    body: VisitPackGeneration,
    idempotencyKey: string,
  ): Promise<ApiOutcome<Record<string, unknown>>>;

  /**
   * Start a reconciliation against a list the person is holding.
   *
   * The list is typed in because Kynviora has no other source for it - a discharge summary is a
   * piece of paper. Nothing here rewrites what was typed.
   */
  startReconciliation(body: StartReconciliation): Promise<ApiOutcome<ReconciliationStarted>>;

  reconciliation(id: string): Promise<ApiOutcome<ReconciliationResponse>>;
  resolveDifference(
    reconciliationId: string,
    differenceId: string,
    resolution: DifferenceResolution,
  ): Promise<ApiOutcome<Record<string, unknown>>>;
  completeReconciliation(id: string): Promise<ApiOutcome<Record<string, unknown>>>;

  /** The same client acting as somebody else. Used by tests and by profile switching. */
  withSession(session: ClientSession): KynvioraClient;
}

export function createClient(options: ClientOptions): KynvioraClient {
  const transport = {
    config: options.config,
    session: options.session,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  };

  const get = <T>(path: string, query?: Readonly<Record<string, QueryValue>>) =>
    request<T>(
      transport,
      query === undefined ? { method: 'GET', path } : { method: 'GET', path, query },
    );

  const send = <T>(
    method: 'POST' | 'PUT' | 'PATCH',
    path: string,
    body: unknown,
    idempotencyKey?: string,
  ) =>
    request<T>(transport, {
      method,
      path,
      body,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });

  return {
    session: options.session,

    health: () => get<{ status: string }>('/health'),

    listProfiles: () => get<ProfilesResponse>('/v1/profiles'),

    listItems: (query) =>
      get<ItemsResponse>('/v1/items', {
        profileId: query.profileId,
        itemKind: query.itemKind,
        lifecycleState: query.lifecycleState,
        verification: query.verification,
        attention: query.attention,
        cursor: query.cursor,
        limit: query.limit,
      }),

    itemDetail: (itemId) => get<ItemDetailResponse>(`/v1/items/${encodeURIComponent(itemId)}`),

    // The body is passed through untouched. Trimming, upper-casing a market or stripping a space
    // out of a barcode here would be the client repairing what somebody typed, and a value
    // Kynviora quietly altered is one they can no longer check against the pack in their hand.
    // The domain refuses and names the field; this sends what it was given.
    createItem: (body, idempotencyKey) =>
      send<ItemCreated>('POST', '/v1/items', body, idempotencyKey),

    // PATCH rather than PUT, because absent and `null` mean different things here and a whole-
    // document PUT could not express "leave this alone".
    updateItem: (itemId, body) =>
      send<ItemUpdated>('PATCH', `/v1/items/${encodeURIComponent(itemId)}`, body),

    // No profile parameter: the route returns what row-level security admits, which is `13`'s
    // "never trust a profile ID in the request as proof of access" applied by construction.
    listAlerts: () => get<AlertsResponse>('/v1/alerts'),

    regulatoryLens: (query) =>
      get<LensResponse>('/v1/regulatory-lens', {
        substanceKey: query.substanceKey,
        productUseType: query.productUseType,
        disclosedConcentrationPercent: query.disclosedConcentrationPercent,
        intendedForAgeYears: query.intendedForAgeYears,
      }),

    // The key is a parameter rather than generated here. A key regenerated on retry is not an
    // idempotency key, it is a second dose event - and `13` requires the server to commit once.
    recordDoseEvent: (body, idempotencyKey) =>
      send<{ id: string | null; serverTime: string }>(
        'POST',
        '/v1/dose-events',
        body,
        idempotencyKey,
      ),

    doseEvents: (query) =>
      get<DoseEventsResponse>('/v1/dose-events', {
        ownedItemId: query.ownedItemId,
        limit: query.limit,
      }),

    listCaregiverGrants: (query) =>
      get<CaregiverGrantsResponse>('/v1/caregiver-grants', { profileId: query?.profileId }),

    createInvitation: (body, idempotencyKey) =>
      send<InvitationCreated>('POST', '/v1/caregiver-invitations', body, idempotencyKey),

    listInvitations: (query) =>
      get<InvitationsResponse>('/v1/caregiver-invitations', { profileId: query?.profileId }),

    // No idempotency key and no body. Revocation has one destination state, so a retry is the
    // same request rather than a second one.
    revokeGrant: (grantId) =>
      send<GrantRevoked>('POST', `/v1/caregiver-grants/${encodeURIComponent(grantId)}/revoke`, {}),

    revokeInvitation: (invitationId) =>
      send<InvitationRevoked>(
        'POST',
        `/v1/caregiver-invitations/${encodeURIComponent(invitationId)}/revoke`,
        {},
      ),

    caregiverAudit: (profileId) =>
      get<CaregiverAuditResponse>(`/v1/profiles/${encodeURIComponent(profileId)}/caregiver-audit`),

    // The filters are repeated parameters rather than one comma-separated value: a list parsed
    // out of one string is a mistake away from a filter that silently matches nothing, and a
    // safety screen showing an empty list for that reason is the failure this route prevents.
    safetyInbox: (profileId, filter) =>
      request<SafetyInboxResponse>(transport, {
        method: 'GET',
        path: `/v1/profiles/${encodeURIComponent(profileId)}/safety-inbox`,
        repeatedQuery: {
          state: filter?.states ?? [],
          urgency: filter?.urgencies ?? [],
        },
      }),

    profileAlerts: (profileId) =>
      get<ProfileAlertsResponse>(`/v1/profiles/${encodeURIComponent(profileId)}/alerts`),

    alertDetail: (alertId) => get<AlertDetailResponse>(`/v1/alerts/${encodeURIComponent(alertId)}`),

    // No idempotency key: there is one destination state and the server answers a repeat with
    // `alreadyReported`, so a retry is the same request rather than a second opinion.
    reportIncorrectMatch: (alertId, body) =>
      request<IncorrectMatchReported>(transport, {
        method: 'POST',
        path: `/v1/alerts/${encodeURIComponent(alertId)}/report-incorrect`,
        body: body ?? {},
      }),

    safetyReceipt: (alertId) =>
      get<SafetyReceiptResponse>(`/v1/alerts/${encodeURIComponent(alertId)}/receipt`),

    // No idempotency key, for the same reason report-incorrect has none: there is one destination
    // state per resolution and the server answers a repeat with `alreadyRecorded`, so a retry is
    // the same request rather than a second record.
    recordResolution: (alertId, body) =>
      request<ResolutionRecorded>(transport, {
        method: 'POST',
        path: `/v1/alerts/${encodeURIComponent(alertId)}/resolutions`,
        body,
      }),

    notificationSettings: (profileId) =>
      get<NotificationSettingsResponse>(
        `/v1/profiles/${encodeURIComponent(profileId)}/notification-settings`,
      ),

    setNotificationPreference: (profileId, detailLevel) =>
      send<Record<string, unknown>>(
        'PUT',
        `/v1/profiles/${encodeURIComponent(profileId)}/notification-preference`,
        { detailLevel },
      ),

    setNotificationPolicy: (profileId, maxCaregiverDetail) =>
      send<Record<string, unknown>>(
        'PUT',
        `/v1/profiles/${encodeURIComponent(profileId)}/notification-policy`,
        { maxCaregiverDetail },
      ),

    reviewTasks: (profileId) =>
      get<ReviewTasksResponse>(`/v1/profiles/${encodeURIComponent(profileId)}/review-tasks`),

    // Completion carries the record changes, because a task is closed by writing to the
    // authoritative record and there is no mark-done path (DEC-027, trap 16).
    completeReviewTask: (taskId, completion) =>
      send<Record<string, unknown>>(
        'POST',
        `/v1/review-tasks/${encodeURIComponent(taskId)}/complete`,
        completion,
      ),

    visitPackCandidates: (profileId) =>
      get<VisitPackCandidatesResponse>('/v1/visit-packs/candidates', { profileId }),

    createVisitPack: (body, idempotencyKey) =>
      send<Record<string, unknown>>('POST', '/v1/visit-packs', body, idempotencyKey),

    startReconciliation: (body) => send<ReconciliationStarted>('POST', '/v1/reconciliations', body),

    reconciliation: (id) =>
      get<ReconciliationResponse>(`/v1/reconciliations/${encodeURIComponent(id)}`),

    resolveDifference: (reconciliationId, differenceId, resolution) =>
      send<Record<string, unknown>>(
        'POST',
        `/v1/reconciliations/${encodeURIComponent(reconciliationId)}/differences/${encodeURIComponent(differenceId)}`,
        resolution,
      ),

    completeReconciliation: (id) =>
      send<Record<string, unknown>>(
        'POST',
        `/v1/reconciliations/${encodeURIComponent(id)}/complete`,
        {},
      ),

    withSession: (session) => createClient({ ...options, session }),
  };
}
