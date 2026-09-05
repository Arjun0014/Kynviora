/**
 * A verified subject is not yet an account (DEC-124).
 *
 * Spec references: `13` (every request derives authority from an authenticated session **and
 * server-side state**), `14` (deny by default; re-authentication for high-impact actions; no
 * oracle on an authentication endpoint), `16` (a person can have their data removed), DEC-118,
 * DEC-120, `DEV-062`, `BLK-010`.
 *
 * WHY THIS EXISTS, AND THE MEASUREMENT THAT PRODUCED IT
 * A Supabase access token is verified **locally**, against a published key set. That is the whole
 * benefit of asymmetric signing and it has one consequence that has to be designed around: this
 * process cannot know that a session was signed out.
 *
 * `supabaseLive.test.ts` measures it against the real project. Sign out, and the provider's own
 * `/user` answers `session_not_found` immediately - while the same token keeps verifying here
 * until `exp`, up to an hour later. Nothing is wrong with the verifier; that is what stateless
 * verification means.
 *
 * So "invalidate sessions immediately" - which `16` requires of account deletion - cannot be
 * satisfied by the token and has to be satisfied by the **server refusing a subject it no longer
 * recognises**. That is what this module is. One indexed read, on the connection the request was
 * going to open anyway, under the caller's own row-level security.
 *
 * WHAT IT REFUSES, AND WHY ALL OF THEM LOOK THE SAME FROM OUTSIDE
 * A subject with no account, a subject whose account is stamped deleted, and a subject whose
 * account is suspended all produce the same `UNAUTHENTICATED` as no token at all. `13` does not
 * let this API be an oracle: a caller learning *which* of those they are learns whether an
 * account exists for a subject they hold a token for, and the difference between "deleted" and
 * "never existed" is exactly the fact a deletion is supposed to remove.
 */

import type { DatabaseConnection, Principal } from './context.js';

/**
 * What the server knows about a verified subject.
 *
 * Three states rather than a boolean, because the log wants the distinction even though the
 * caller must not have it: an operator seeing `ACCOUNT_DELETED` is watching retention work, and
 * one seeing `ACCOUNT_ABSENT` is watching somebody who signed up and never registered.
 */
export type AccountState = 'ACTIVE' | 'ACCOUNT_ABSENT' | 'ACCOUNT_DELETED' | 'ACCOUNT_SUSPENDED';

/**
 * Statuses that are not a live account.
 *
 * `PENDING_DELETION` is deliberately **not** here. DEC-120's deletion is synchronous - the row is
 * stamped and revoked in the request that accepts it - so a person in that state has already
 * stopped being able to reach anything by `deleted_at`. Refusing on the status as well would mean
 * two independent switches for one fact, and the one nobody remembered to set would be the one
 * that mattered.
 */
const REFUSED_STATUSES: Record<string, AccountState> = {
  DELETED: 'ACCOUNT_DELETED',
  SUSPENDED: 'ACCOUNT_SUSPENDED',
};

/**
 * Resolve the caller's account, under their own row-level security.
 *
 * `app_user_self_select` admits exactly one row - the caller's - so this reads nothing it is not
 * entitled to and needs no privileged connection. A subject with no row sees no row, which is the
 * same answer the policy gives a stranger and requires no separate branch.
 */
export async function resolveAccountState(db: DatabaseConnection): Promise<AccountState> {
  const result = await db.query<{ status: string; deleted: boolean }>(
    `SELECT status, deleted_at IS NOT NULL AS deleted
       FROM app_user
      WHERE id = kynviora.current_user_id()`,
  );
  const row = result.rows[0];
  if (row === undefined) return 'ACCOUNT_ABSENT';
  // The stamp first. A row may be stamped deleted before its status has caught up, and the stamp
  // is what every retention policy in `0023` reads - so it is what this reads too.
  if (row.deleted) return 'ACCOUNT_DELETED';
  return REFUSED_STATUSES[row.status] ?? 'ACTIVE';
}

/**
 * The route that may run without an account, because it is the one that creates it.
 *
 * A closed set of exactly one member, expressed as a type rather than as a boolean parameter, so
 * that adding a second one is a change somebody has to write down.
 */
export type UnprovisionedRoute = 'REGISTER_ACCOUNT';

export interface AccountCheck {
  readonly state: AccountState;
  readonly principal: Principal;
}
