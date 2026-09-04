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

import type { PersonalExportManifest } from '@kynviora/domain';
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
  /**
   * The household this profile is in (`04` Phase 1.2).
   *
   * Carried so that adding a second person adds them beside the first rather than to a new
   * household. Two households are not a duplicate row: every later record hangs off one, and
   * nothing in this build merges them.
   */
  readonly householdId: string;
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
   * Whether this caller may record a dose against it.
   *
   * A separate answer from {@link ItemDetailResponse.mayEdit} and separately asked, because
   * migration `0021` made them separate capabilities: `RECORD_DOSES` writes into the dose history,
   * `MANAGE_MEDICINES` changes the medicine itself, and a caregiver may well hold the first and
   * not the second (`DEV-049`). A screen that reused `mayEdit` here would withhold the dose
   * controls from exactly the people the capability was added for.
   */
  readonly mayRecordDoses: boolean;
  /**
   * Whether this caller may delete it.
   *
   * A third answer rather than one implied by the other two, because deletion is not a
   * capability. docs/RETENTION.md section 2: no caregiver capability authorises it, so the server
   * answers this with ownership - a caregiver holding every capability there is reads `false`
   * here while both of the others are `true`.
   *
   * Optional on the wire so a client reading an older server does not fail its own contract
   * validation; {@link itemDetailScreenView} defaults it to `false`.
   */
  readonly mayDelete?: boolean;
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
  /**
   * Whether this caller may record a dose on the profile this page was read for.
   *
   * One boolean for the page rather than one per row: a capability is granted per profile and this
   * list is filtered to one, so a per-item answer would be the same value repeated and would
   * invite a screen to believe two medicines belonging to one person could differ.
   *
   * Optional on the wire so a client reading an older server does not fail its own contract
   * validation. {@link shelfView} defaults it to `false`, because deny-by-default applies to a
   * control as much as to a read (`14`) - a withheld control costs a tap, and one the write
   * refuses costs somebody a record they believed they had made.
   */
  readonly mayRecordDoses?: boolean;
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

// ---------------------------------------------------------------------------
// Consent (`04` Phase 1.4)
// ---------------------------------------------------------------------------

export interface ConsentStandingLine {
  readonly purpose: string;
  readonly granted: boolean;
  /** Whether anybody has ever answered. Distinct from having answered "no". */
  readonly everAnswered: boolean;
  readonly policyVersion: string | null;
  readonly recordedAt: string | null;
  /**
   * Whether withdrawing this actually stops anything in **this** build.
   *
   * `ENFORCED`, `NOTHING_TO_STOP` or `REQUIRED`. Reported by the server rather than assumed by a
   * screen, so a purpose that becomes enforceable is described correctly without anybody
   * remembering to edit a client - and so that until then nobody is offered a switch they believe
   * does something (`10`).
   */
  readonly enforcement: string;
  readonly optional: boolean;
  /** Whether the standing answer predates the policy text now in force. */
  readonly stale: boolean;
}

export interface ConsentsResponse {
  readonly policyVersion: string;
  readonly consents: readonly ConsentStandingLine[];
  readonly serverTime: string;
}

/**
 * A consent decision.
 *
 * No `userId`, no `policyVersion` and no `recordedAt`. The first is the session's and the database
 * checks it; the second and third are the server's, because a client that could name the policy
 * version it agreed to could record agreement to a text nobody showed them.
 */
export interface ConsentBody {
  readonly purpose: string;
  readonly granted: boolean;
  /** The language the policy was read in. `16` asks for consent state to be localizable. */
  readonly locale?: string | null;
}

/**
 * A copy of everything held about the caller (spec 16 export, DEC-117).
 *
 * The manifest is typed because a screen reads it: what is included, what is not, and which
 * sources are named rather than copied. The data is not, and that is deliberate - the sections
 * are database rows, and a client-side type sitting between a person and their own record would
 * silently drop any column it did not know about. A copy that quietly omits a field is the one
 * failure this feature cannot have.
 */
export interface PersonalExportResponse {
  readonly manifest: PersonalExportManifest;
  readonly data: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
}

export interface ConsentRecorded {
  readonly purpose: string;
  readonly granted: boolean;
  readonly policyVersion: string;
  readonly locale: string;
  readonly recordedAt: string;
  readonly enforcement: string;
  readonly serverTime: string;
}

// ---------------------------------------------------------------------------
// Health context (`04` Phase 1.3)
// ---------------------------------------------------------------------------

/**
 * A reaction somebody is recording.
 *
 * Note what is not here: no `provenance` and no `substanceId`. The first is derived by the server
 * from whether the caller owns the profile, and its absence is the whole of Phase 1.3's first exit
 * criterion - "no OCR or inferred fact silently becomes a confirmed diagnosis" - because there is
 * no field a client could set. The second is the catalog's business: a household typing
 * "penicillin" is not the catalog learning a substance (`15` A11).
 */
export interface HealthFactBody {
  readonly kind: string;
  readonly displayTerm: string;
  readonly certainty?: string | null;
  readonly notedOn?: string | null;
}

export interface HealthFactCreated {
  readonly id: string;
  readonly version: number;
  readonly kind: string;
  readonly displayTerm: string;
  readonly certainty: string;
  /** The server's answer about the caller, never an echo of anything they sent. */
  readonly provenance: string;
  readonly notedOn: string | null;
  readonly lastReviewedAt: string | null;
  readonly serverTime: string;
}

export interface HealthFactLine {
  readonly id: string;
  readonly kind: string;
  readonly displayTerm: string;
  readonly provenance: string;
  readonly certainty: string;
  readonly notedOn: string | null;
  readonly lastReviewedAt: string | null;
  readonly version: number;
  /**
   * Whether this fact can drive a rule that matches on canonical substances.
   *
   * Reported rather than left for a screen to infer from a missing field: `04` Phase 5.2 makes
   * the mapping the catalog's business, and an unmapped term is a real state a person should be
   * told about.
   */
  readonly matchesCanonicalSubstance: boolean;
  /**
   * Why it is or is not matched (`04` Phase 5.2).
   *
   * `EXACT`, `AMBIGUOUS` or `UNRESOLVED`. Reported alongside the boolean rather than instead of
   * it: the boolean is what decides whether a rule can see the record, and this is what decides
   * which sentence the person reads about why. A value this build cannot read is treated as
   * `UNRESOLVED`, which is the sentence that promises least.
   */
  readonly substanceMappingState?: string;
}

export interface HealthFactsResponse {
  readonly profileId: string;
  readonly facts: readonly HealthFactLine[];
  readonly serverTime: string;
}

/**
 * A correction to a fact that already exists.
 *
 * Conditional on the version: `sync.ts` sets `allergy_record`'s conflict policy to `ASK_USER`, and
 * losing a recorded allergy to a stale offline edit is the case that policy exists for. There is
 * no `provenance` here either - a person who could edit a fact into `REVIEWER_CONFIRMED` would
 * have found the way round the exit criterion the create path closes.
 */
export interface HealthFactChangeBody {
  readonly expectedVersion: number;
  readonly displayTerm?: string | null;
  readonly certainty?: string | null;
  readonly notedOn?: string | null;
  /** Whether this edit also counts as looking at the record. Never inferred from an edit. */
  readonly markReviewed?: boolean;
}

export interface HealthFactUpdated {
  readonly id: string;
  readonly version: number;
  readonly changedFields: readonly string[];
  readonly lastReviewedAt: string | null;
  readonly serverTime: string;
}

// ---------------------------------------------------------------------------
// Making a household, and the people in it (`04` Phase 1.2)
// ---------------------------------------------------------------------------

/**
 * A household somebody is creating.
 *
 * One field. There is deliberately no `ownerUserId`: the owner is the caller, decided by the
 * request context and checked by `household_insert`, and a body that could name one would be an
 * authorization statement travelling from a client.
 */
export interface HouseholdBody {
  readonly displayName: string;
}

export interface HouseholdCreated {
  readonly id: string;
  readonly displayName: string;
  readonly replayed: boolean;
  readonly serverTime: string;
}

/**
 * A profile somebody is creating.
 *
 * `birthYear` is a string because the domain refuses `58` rather than reading it as `1958`, and a
 * number has already lost the difference between what was typed and what was meant.
 *
 * There is no `selfUserId` and no `ownerUserId`. `isSelf` is a claim the caller makes about
 * themselves and is the only identity statement this body can carry - a profile asserting that
 * somebody else is its subject would be written by the wrong person, and `self_user_id` is unique,
 * so it would also take a name that person could never claim.
 */
export interface ProfileBody {
  readonly householdId: string;
  readonly displayName: string;
  readonly ageBand?: string | null;
  readonly birthYear?: string | null;
  readonly languageTag?: string | null;
  readonly isSelf?: boolean;
}

export interface ProfileCreated {
  readonly id: string;
  readonly householdId: string;
  readonly displayName: string;
  readonly ageBand: string | null;
  readonly birthYear: number | null;
  /** Whether the profile is the caller themselves. */
  readonly isSelf: boolean;
  /** Whether it is for somebody the caller looks after. The other side of the same answer. */
  readonly isManaged: boolean;
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

/**
 * When a medicine is meant to be taken (`04` Phase 4.1).
 *
 * There is no dose, quantity or instruction field, and there must not be one. `09` forbids
 * Kynviora reinterpreting a prescriber's instruction; the written directions live on the item as
 * `directionsText`, in the words they were given in. A schedule says *when*.
 *
 * Times are local wall-clock plus an IANA zone rather than instants, which is `04` Phase 4.1's
 * time-zone rule: "08:00" survives a daylight-saving transition and a flight, and an instant
 * computed once at save time would move a dose by an hour twice a year.
 */
export interface ScheduleBody {
  readonly scheduleKind: string;
  /** `HH:MM`, 24-hour. Absent or empty for `AS_NEEDED`. */
  readonly timesLocal?: readonly string[];
  /** ISO weekdays, 1 = Monday. Absent means every day; only `SELECTED_DAYS` may carry them. */
  readonly daysOfWeek?: readonly number[] | null;
  readonly timeZone: string;
  readonly startsOn?: string | null;
  readonly endsOn?: string | null;
}

/**
 * A change to a schedule that already exists.
 *
 * Whole-document rather than partial, which is why it repeats the kind and the times. A
 * schedule's kind, times and days are one statement: "twice a day" with the times omitted is not
 * a partial edit, and patching them independently is how a `SELECTED_DAYS` row ends up with no
 * days - a schedule that never fires, on a medicine somebody believes they are reminded about.
 */
export interface ScheduleChangeBody extends ScheduleBody {
  readonly expectedVersion: number;
  /** Absent leaves it alone. `false` is how reminders stop; nothing here deletes a row. */
  readonly active?: boolean;
}

export interface Schedule {
  readonly id: string;
  readonly ownedItemId: string;
  readonly scheduleKind: string;
  readonly timesLocal: readonly string[];
  readonly daysOfWeek: readonly number[] | null;
  readonly timeZone: string;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly active: boolean;
  readonly version: number;
  readonly updatedAt: string | null;
}

export interface SchedulesResponse {
  readonly schedules: readonly Schedule[];
  readonly serverTime: string;
}

/**
 * A schedule with the medicine it belongs to named, as the profile-scoped read returns it.
 *
 * The name is here because the device plans reminders from this one response. Joining it against
 * a separate shelf read would be two moments, and a schedule whose item was missing from the
 * other one would be planned with no name - so at the disclosure level that shows names, the
 * person would get a reminder that could not say what it was for.
 */
export interface ScheduleWithItem extends Schedule {
  readonly itemDisplayName: string;
}

/** Everything a device needs to plan a profile's reminders, from one request. */
export interface ProfileSchedulesResponse {
  readonly profileId: string;
  /** Null where the caller cannot read the profile. Never a placeholder. */
  readonly profileDisplayName: string | null;
  readonly schedules: readonly ScheduleWithItem[];
  readonly serverTime: string;
}

export interface ScheduleWritten {
  readonly schedule: Schedule;
  readonly replayed?: boolean;
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
  /**
   * The window notifications are held in, or `null` (`04` Phase 7.5).
   *
   * Sent to every reader of the settings, not only the owner. `16`'s reason: a caregiver who
   * receives nothing at 3am deserves to know a window is doing that rather than a bug, which is
   * the same reason the ceiling is readable.
   */
  readonly quietHours: { readonly startMinute: number; readonly endMinute: number } | null;
  /** The window as a person reads it, composed on the server. `null` where none is set. */
  readonly quietHoursLabel: string | null;
  /** The approved wording, including the exception a person must know before relying on it. */
  readonly quietHoursCopy: Readonly<Record<string, string>>;
  /**
   * Whether a window that is set actually holds anything today.
   *
   * `false` in this build, for two reasons the server holds together in one constant: nothing
   * supplies a recipient's local minute (`DEV-030`), and nothing dispatches a notification at all
   * (`BLK-009`). Reported rather than assumed by a screen, so that when either changes the screen
   * follows without anybody remembering to edit it - and so that until then nobody is told quiet
   * hours are working when they are not.
   */
  readonly quietHoursApplied: boolean;
  /**
   * What each urgency does.
   *
   * Read from the domain's ceiling on the server rather than restated by a client, so a screen
   * cannot describe a policy the server does not have.
   */
  readonly urgencyChannels: readonly {
    readonly urgency: string;
    readonly channelLabel: string;
    readonly channelDescription: string;
  }[];
  readonly serverTime: string;
}

/**
 * The owner's ceiling and the window, together (`04` Phase 7.5).
 *
 * One body, because the route writes one row and a partial write would leave the other half at
 * whatever it was - which for quiet hours means silently clearing a window somebody set. The two
 * bounds are set or cleared together for the same reason the schema requires it: one alone is a
 * window whose other end somebody has to invent.
 */
export interface NotificationPolicyBody {
  readonly maxCaregiverDetail: string;
  readonly quietHoursStartMinute: number | null;
  readonly quietHoursEndMinute: number | null;
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
   * What somebody has agreed to, and changing it (`04` Phase 1.4).
   *
   * Neither takes a user. `consent_select` and `consent_insert` both require the row to be the
   * caller's own, so consent is the one thing in this product nobody may exercise or read on
   * somebody else's behalf - not even a profile owner for a caregiver.
   */
  consents(): Promise<ApiOutcome<ConsentsResponse>>;
  recordConsent(body: ConsentBody): Promise<ApiOutcome<ConsentRecorded>>;
  /**
   * Everything Kynviora holds about this account, as one document (spec 16 export, DEC-117).
   *
   * Requires fresh step-up, so this is called with an elevated client. There is no artifact and
   * no link: the copy is assembled per request and written to the response, so nothing with a
   * lifetime exists on the server and there is nothing to expire.
   *
   * Returned untyped past the manifest on purpose. The sections are database rows, and giving
   * them client-side types would mean a shape this build believes in sitting between a person and
   * their own record - a column the types did not know about would be dropped from the copy
   * rather than passed through, which is the one failure a copy cannot have.
   */
  exportPersonalData(): Promise<ApiOutcome<PersonalExportResponse>>;

  /**
   * What a household records about a person (`04` Phase 1.3).
   *
   * No idempotency key. A retried create would make a second identical allergy row, which is
   * visible on the list, correctable, and harmless where a second household is none of those -
   * and it is the honest alternative to a key the server does not enforce.
   */
  healthFacts(profileId: string): Promise<ApiOutcome<HealthFactsResponse>>;
  addHealthFact(profileId: string, body: HealthFactBody): Promise<ApiOutcome<HealthFactCreated>>;
  updateHealthFact(
    factId: string,
    body: HealthFactChangeBody,
  ): Promise<ApiOutcome<HealthFactUpdated>>;

  /**
   * Make a household, and make a person in it (`04` Phase 1.2).
   *
   * Both take an idempotency key, and both require one at the server. Two households are not a
   * duplicate row on a list: every later record hangs off one, so two copies collect separate
   * items, caregivers and safety history, and nothing in this build merges them.
   */
  createHousehold(
    body: HouseholdBody,
    idempotencyKey: string,
  ): Promise<ApiOutcome<HouseholdCreated>>;
  createProfile(body: ProfileBody, idempotencyKey: string): Promise<ApiOutcome<ProfileCreated>>;
  /**
   * Change an item that already exists (`04` Stage 2 - update, archive, review).
   *
   * No idempotency key, and that is not an omission. The write is conditional on
   * `expectedVersion`, so a retry either lands once or comes back as a conflict - the same
   * guarantee a key gives, from the mechanism `13`'s `ASK_USER` policy already required. A second
   * key would be a second answer to the same question.
   */
  updateItem(itemId: string, body: ItemUpdateBody): Promise<ApiOutcome<ItemUpdated>>;
  /**
   * Remove an item, at its owner's request (`16`, DEC-117).
   *
   * A different act from archiving, which `updateItem` does: archiving is "I am done with this
   * and want to keep the record", deletion is "I want this gone". Answering the second with the
   * first tells somebody their data was removed while it is still on every caregiver's shelf.
   *
   * Requires **fresh step-up**, so this is called with an elevated client - `14` names deletion
   * alongside export and caregiver administration. It also needs no version and no idempotency
   * key, and neither is an omission: deleting an item that is already deleted is refused as
   * not-found rather than repeated, so a retry cannot produce a second deletion and a stale copy
   * cannot delete the wrong thing - the identifier is the whole of what is being named.
   *
   * Resolves to `null` on success. The route answers `204` with no body, because a body naming
   * what was removed would be the one place in this API that hands health content back after
   * being asked to destroy it.
   */
  deleteItem(itemId: string): Promise<ApiOutcome<null>>;
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
  /**
   * The owner's ceiling and the quiet-hours window.
   *
   * Requires step-up (`14`), which is why the session carries it rather than this method: raising
   * the ceiling widens what leaves the profile onto other people's devices, and changing the
   * window changes when Kynviora is allowed to interrupt somebody.
   */
  setNotificationPolicy(
    profileId: string,
    body: NotificationPolicyBody,
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

  /**
   * When a medicine is meant to be taken (`04` Phase 4.1), and what Phase 4.2 reminds from.
   *
   * `createSchedule` takes an idempotency key and the server requires one. A key regenerated on
   * retry would put two schedules on one medicine, and the reminder engine reads every active
   * schedule for an item - so the symptom is not a duplicate row on a list. It is being told
   * twice, at the same minute, to take the same tablet.
   *
   * `updateSchedule` takes no key and is conditional on `expectedVersion` instead, which gives
   * the same once-only guarantee from the mechanism `13`'s per-entity conflict policy already
   * required: a retry either lands once or comes back as a conflict.
   *
   * Reading and writing are different permissions (`08.2`). A caregiver granted `VIEW_MEDICINES`
   * lists the times and cannot move them; `MANAGE_MEDICINES` is what the write path requires, and
   * a refusal arrives as the same not-found an unknown medicine gets.
   */
  schedules(itemId: string): Promise<ApiOutcome<SchedulesResponse>>;
  /**
   * Every schedule on a profile, with the medicine each belongs to named.
   *
   * What the reminder engine reads (`04` Phase 4.2). One request rather than one per medicine,
   * because the offline copy keeps whole responses (`12`): several rows that can each be
   * separately stale is a plan assembled from several different moments, and the medicine whose
   * row failed simply gets no reminders.
   */
  profileSchedules(profileId: string): Promise<ApiOutcome<ProfileSchedulesResponse>>;
  createSchedule(
    itemId: string,
    body: ScheduleBody,
    idempotencyKey: string,
  ): Promise<ApiOutcome<ScheduleWritten>>;
  updateSchedule(
    scheduleId: string,
    body: ScheduleChangeBody,
  ): Promise<ApiOutcome<ScheduleWritten>>;

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

    consents: () => get<ConsentsResponse>('/v1/consents'),

    // PUT rather than POST: one standing answer per purpose, and re-sending the same one is not a
    // second decision. The server still writes a new receipt each time, because the table is
    // append-only and the history is the point.
    recordConsent: (body) => send<ConsentRecorded>('PUT', '/v1/consents', body),

    exportPersonalData: () => get<PersonalExportResponse>('/v1/export'),

    healthFacts: (profileId) =>
      get<HealthFactsResponse>(`/v1/profiles/${encodeURIComponent(profileId)}/health-facts`),

    addHealthFact: (profileId, body) =>
      send<HealthFactCreated>(
        'POST',
        `/v1/profiles/${encodeURIComponent(profileId)}/health-facts`,
        body,
      ),

    // PATCH rather than PUT, because absent and `null` mean different things here and a
    // whole-document PUT could not express "leave this alone".
    updateHealthFact: (factId, body) =>
      send<HealthFactUpdated>('PATCH', `/v1/health-facts/${encodeURIComponent(factId)}`, body),

    createHousehold: (body, idempotencyKey) =>
      send<HouseholdCreated>('POST', '/v1/households', body, idempotencyKey),

    // The key is the caller's, and re-sending the same one is how a person who tapped twice gets
    // one profile. The server reads back the row that exists rather than echoing the second body.
    createProfile: (body, idempotencyKey) =>
      send<ProfileCreated>('POST', '/v1/profiles', body, idempotencyKey),

    // PATCH rather than PUT, because absent and `null` mean different things here and a whole-
    // document PUT could not express "leave this alone".
    updateItem: (itemId, body) =>
      send<ItemUpdated>('PATCH', `/v1/items/${encodeURIComponent(itemId)}`, body),

    deleteItem: (itemId) =>
      request<null>(transport, {
        method: 'DELETE',
        path: `/v1/items/${encodeURIComponent(itemId)}`,
      }),

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

    // The whole policy every time. Sending only the changed half would leave the other at
    // whatever it was - and for quiet hours that means a window somebody set being cleared by a
    // request that never mentioned it.
    setNotificationPolicy: (profileId, body) =>
      send<Record<string, unknown>>(
        'PUT',
        `/v1/profiles/${encodeURIComponent(profileId)}/notification-policy`,
        body,
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

    schedules: (itemId) =>
      get<SchedulesResponse>(`/v1/items/${encodeURIComponent(itemId)}/schedules`),

    profileSchedules: (profileId) =>
      get<ProfileSchedulesResponse>(`/v1/profiles/${encodeURIComponent(profileId)}/schedules`),

    // The body is passed through untouched. Rounding a time to the nearest five minutes or
    // guessing a zone from the device here would be the client altering what somebody entered
    // about when they take a medicine. The domain refuses and names the field.
    createSchedule: (itemId, body, idempotencyKey) =>
      send<ScheduleWritten>(
        'POST',
        `/v1/items/${encodeURIComponent(itemId)}/schedules`,
        body,
        idempotencyKey,
      ),

    // Addressed by schedule rather than by item: the row already knows which medicine it belongs
    // to, and a path carrying both would let the two disagree.
    updateSchedule: (scheduleId, body) =>
      send<ScheduleWritten>('PATCH', `/v1/schedules/${encodeURIComponent(scheduleId)}`, body),

    withSession: (session) => createClient({ ...options, session }),
  };
}
