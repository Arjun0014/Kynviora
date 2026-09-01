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
}

export interface ItemsResponse {
  readonly items: readonly ShelfItem[];
  readonly nextCursor: string | null;
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
  readonly state: string;
  readonly urgency: string | null;
  readonly evidenceLevel: string | null;
  /** When Kynviora last assessed this item, or `null` for never. The absence is the point. */
  readonly lastAssessedAt: string | null;
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

export interface LensResponse {
  readonly lens: unknown;
  readonly serverTime: string;
}

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

export interface ItemsQuery {
  readonly profileId: string;
  readonly itemKind?: 'MEDICINE' | 'PERSONAL_CARE';
  readonly lifecycleState?: 'ACTIVE' | 'STOPPED' | 'ARCHIVED';
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
  listAlerts(): Promise<ApiOutcome<AlertsResponse>>;
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

  const send = <T>(method: 'POST' | 'PUT', path: string, body: unknown, idempotencyKey?: string) =>
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
        cursor: query.cursor,
        limit: query.limit,
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
