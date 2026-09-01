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
  readonly isManaged: boolean;
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
}

export interface CaregiverGrantsResponse {
  readonly grants: readonly CaregiverGrant[];
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

  listCaregiverGrants(query?: {
    readonly profileId?: string;
  }): Promise<ApiOutcome<CaregiverGrantsResponse>>;

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
  createVisitPack(body: VisitPackGeneration): Promise<ApiOutcome<Record<string, unknown>>>;

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

    listCaregiverGrants: (query) =>
      get<CaregiverGrantsResponse>('/v1/caregiver-grants', { profileId: query?.profileId }),

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

    createVisitPack: (body) => send<Record<string, unknown>>('POST', '/v1/visit-packs', body),

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
