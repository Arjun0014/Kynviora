/**
 * Request context, the database port, and the authorization boundary.
 *
 * Spec references: `13` (authorization, privileged operations), `14` (deny by default),
 * `11` (server-authoritative safety and caregiver authorization).
 *
 * THE CENTRAL RULE
 * `13`: "Every request derives authority from authenticated user/session and server-side grants.
 * Never trust a profile ID in the request as proof of access."
 *
 * That rule is implemented structurally here. A route handler receives a `RequestContext` whose
 * only database access is `ctx.db` - a connection already bound to the `kynviora_app` role with
 * the authenticated user's ID set in the request GUC. There is no way for a handler to reach an
 * unscoped connection, so RLS applies to every query a handler can make.
 *
 * Privileged work goes through `ctx.privileged()`, which is deliberately verbose and is the only
 * path to the service role.
 */

import type { Instant, Logger, OperationId, UserId } from '@kynviora/domain';

/** A minimal database interface, so the API is testable without a live Postgres. */
export interface DatabaseConnection {
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: TRow[]; affectedRows?: number }>;
}

/**
 * A pool that can produce a connection bound to a specific role and user.
 *
 * The two methods exist separately so that reaching the service role is an explicit, greppable
 * act rather than a parameter someone might pass by accident.
 */
export interface DatabasePool {
  /** A connection as `kynviora_app`, with `kynviora.user_id` set. RLS applies in full. */
  withUser<T>(userId: UserId | null, fn: (db: DatabaseConnection) => Promise<T>): Promise<T>;
  /** A connection as `kynviora_service`. For privileged operations only (`13`). */
  withService<T>(fn: (db: DatabaseConnection) => Promise<T>): Promise<T>;
}

/** Authenticated principal for a request. */
export interface Principal {
  readonly userId: UserId;
  /**
   * Whether this session has recently completed step-up authentication.
   *
   * `14` requires re-authentication for exports, caregiver administration and account deletion.
   * Routes that need it check this rather than assuming a valid session is sufficient.
   */
  readonly stepUpVerifiedAt: Instant | null;
}

export interface RequestContext {
  readonly principal: Principal;
  readonly correlationId: string;
  readonly now: Instant;
  readonly logger: Logger;
  readonly operationId?: OperationId;

  /**
   * Run a query as the authenticated user, under row-level security.
   *
   * The only database access a route handler has by default.
   */
  db<T>(fn: (db: DatabaseConnection) => Promise<T>): Promise<T>;

  /**
   * Run a privileged operation as the service role.
   *
   * Named to be conspicuous. `13` enumerates what legitimately belongs here: caregiver grant
   * finalisation, shared catalog approval, source and rule publication, assessment publication,
   * audit writes, export generation, deletion orchestration, provider credential use and
   * notification dispatch. Anything else reading user data through this path is a bug, because
   * it bypasses the RLS layer that makes cross-profile exposure structurally hard.
   */
  privileged<T>(reason: PrivilegedReason, fn: (db: DatabaseConnection) => Promise<T>): Promise<T>;
}

/**
 * Why a privileged operation is being performed.
 *
 * A closed set, recorded in the audit trail. Requiring a reason means a reviewer can ask "why
 * does this route need the service role?" and get an answer from the code.
 */
export const PRIVILEGED_REASONS = [
  'CAREGIVER_GRANT_FINALISATION',
  'CATALOG_PUBLICATION',
  'SOURCE_PUBLICATION',
  'RULE_PUBLICATION',
  'ASSESSMENT_PUBLICATION',
  'AUDIT_WRITE',
  // Reading the audit log is privileged for the same reason writing it is: the app role holds no
  // grant on audit_event at all. A route using this must establish the caller authority over the
  // subject itself, because a service connection has no row-level security to fall back on.
  'AUDIT_READ',
  'EXPORT_GENERATION',
  // Deriving the Review Inbox reads the whole profile - items, grants, alerts, refill estimates.
  // Running it under the caller's row-level view would make the *stored* task list depend on who
  // last opened it, so a caregiver with narrow capabilities would silently shrink the owner's
  // list by looking at it. The listing is filtered by RLS afterwards instead.
  'REVIEW_TASK_DERIVATION',
  // A reconciliation writes rows describing two medication lists, one of which the caller typed
  // in. The rows are about the profile rather than about the caller, and the difference set must
  // be identical whoever opens it, so creation and resolution recording go through the service
  // role. The one write to a medicine deliberately does not: it goes through RLS, so the inbox
  // cannot change what the caller could not have changed on the medicine screen itself.
  'RECONCILIATION',
  // The reviewer console has no app-role grant at all - spec 14 keeps publication state off every
  // user surface - so every read and write here is privileged by construction. Authorization is
  // the stored reviewer role, checked in SQL, because a service connection has no row-level
  // security to fall back on.
  'REVIEWER_CONSOLE',
  'ACCOUNT_DELETION',
  // Turning a verified subject into an app_user row. The app role cannot insert one - nothing
  // may create an identity for itself - and the row has to exist before row-level security can
  // admit anything at all, which is the ordering that makes this privileged (DEC-124).
  'ACCOUNT_REGISTRATION',
  // Deleting a record at somebody's request. Privileged not because the route wants a wider hand
  // but because the app role cannot write a revocation stamp at all: Postgres applies the SELECT
  // policies to the new row of an UPDATE that reads the table, and every read predicate filters
  // `deleted_at IS NULL`, so the row a deletion produces is one the caller may not see
  // (`DEV-057`). `13` names deletion orchestration among privileged operations for this reason.
  // The privilege is kept the size of the act: the only thing reached through it is
  // `kynviora.delete_owned_item`, which re-checks ownership in the statement that writes.
  'DATA_DELETION',
  'PROVIDER_CREDENTIAL_USE',
  'NOTIFICATION_DISPATCH',
  'IDEMPOTENCY_BOOKKEEPING',
  // Recording a safety receipt. The app role holds SELECT and UPDATE on `safety_receipt` and
  // deliberately no INSERT: migration 0006 gives a person the right to resolve a receipt that
  // exists, not to create rows pointing at whichever alert and assessment they name. So the
  // insert is privileged, and the route establishes authority first by reading the alert under
  // row-level security - a caller who cannot see it cannot report on it.
  'SAFETY_RECEIPT',
  // Recording that an alert opened from a notification was revalidated. The app role reads its
  // own rows and holds no INSERT: a person may report that they opened something, not create
  // rows naming whichever alert and user they like. The route establishes authority first by
  // reading the alert under row-level security, exactly as the receipt insert does.
  'NOTIFICATION_REVALIDATION',
] as const;
export type PrivilegedReason = (typeof PRIVILEGED_REASONS)[number];

export interface CreateContextOptions {
  readonly pool: DatabasePool;
  readonly principal: Principal;
  readonly correlationId: string;
  readonly now: Instant;
  readonly logger: Logger;
  readonly operationId?: OperationId;
}

export function createRequestContext(options: CreateContextOptions): RequestContext {
  const { pool, principal, correlationId, now, logger, operationId } = options;

  const base = {
    principal,
    correlationId,
    now,
    logger,
    db<T>(fn: (db: DatabaseConnection) => Promise<T>): Promise<T> {
      return pool.withUser(principal.userId, fn);
    },
    privileged<T>(
      reason: PrivilegedReason,
      fn: (db: DatabaseConnection) => Promise<T>,
    ): Promise<T> {
      // Recorded without any payload: spec 14 forbids sensitive content in logs, so this
      // captures the fact and the reason, never the data touched.
      logger.info('api.privileged_operation', {
        reason,
        correlation_id: correlationId,
      });
      return pool.withService(fn);
    },
  };

  return operationId === undefined ? base : { ...base, operationId };
}

/**
 * How long a step-up authentication remains valid.
 *
 * Fifteen minutes: long enough to complete a multi-step sensitive flow such as configuring a
 * caregiver grant, short enough that an unattended device does not stay privileged.
 */
export const STEP_UP_VALIDITY_MS = 15 * 60 * 1000;

/**
 * Whether a request may perform a high-impact action.
 *
 * `14` lists exports, caregiver administration and account deletion. A merely-valid session is
 * explicitly not sufficient.
 */
export function hasFreshStepUp(ctx: RequestContext): boolean {
  const verifiedAt = ctx.principal.stepUpVerifiedAt;
  if (verifiedAt === null) return false;
  return Date.parse(ctx.now) - Date.parse(verifiedAt) <= STEP_UP_VALIDITY_MS;
}
