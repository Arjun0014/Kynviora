/**
 * Registering an account, reading it, and removing it (DEC-124, DEC-125, `DEV-062`).
 *
 * Spec references: `16` (a person can have their data removed; the deletion workflow enumerates
 * device local data, primary records, object storage, derived projections, queued jobs, cached
 * exports, notification tokens and backups), `14` (re-authentication for high-impact actions; no
 * oracle), `13` (identity from an authenticated session), `04` Phase 1.4, DEC-117, DEC-118,
 * DEC-120, `BLK-010`.
 *
 * THE THREE ROUTES AND WHY THEY ARE TOGETHER
 * They are one lifecycle and they share one hazard: each of them is about the *account* rather
 * than about anything in it, so each has to work when the account does not yet exist or no longer
 * does. `POST` and `DELETE` are the only routes in this API exempt from the account check that
 * DEC-124 put in front of everything else - the first because it creates the account, the second
 * because a deletion that failed part-way has to be finishable by the person it belongs to.
 *
 * WHERE THE EMAIL COMES FROM, AND WHY NOT THE TOKEN
 * DEC-118 reads `sub` from a verified token and nothing else. Registration needs an email -
 * `app_user.email_normalized` is `NOT NULL UNIQUE` and is what an emailed caregiver invitation
 * binds to - and it needs to know whether that email is **verified**, which the access token does
 * not say at all.
 *
 * So it is read from the provider, server to server, authenticated with the caller's own token.
 * That is not a client-supplied field and it is not a snapshot from whenever the token was issued;
 * it is what the provider says now. The cost is one call, once per account, on a route that runs
 * once in a person's life.
 *
 * THE DELETION ORDER, WHICH DEC-120 GOT RIGHT FOR A REASON THAT NO LONGER APPLIES
 * DEC-120 said the auth identity must be removed first, so that a failure part-way leaves an
 * account that still works rather than one that cannot be reached and cannot be removed. The
 * premise was that stamping locally first would leave "somebody who can sign in successfully to a
 * row that is gone".
 *
 * DEC-124 removed that premise: a stamped account produces **no session at all**, so signing in
 * afterwards is not a broken success, it is a clean refusal. And the reverse order has the failure
 * that cannot be recovered from - identity gone, data not stamped, and the person with no way to
 * ask again. So the order is now local first, and the capability to finish is checked **before**
 * anything is written, which is what stops a half-deletion from being possible at all.
 *
 * THE THIRD ORDERING, AND THE THING THAT FORCED IT
 * Local, then the **identity**, then the sessions - not local, sessions, identity, which is what
 * this did until the removal stopped needing a service-role key.
 *
 * `close-identity` is driven by the caller's own token: it reads the subject from claims Supabase
 * has already verified, so it cannot be pointed at anybody else, which is the whole reason it is
 * preferred. The cost is that it needs that token to still work - and a global sign-out
 * invalidates it at the provider **immediately** (the finding behind DEC-124, measured in
 * `supabaseLive.test.ts`). Signing out first therefore left the removal unable to authenticate at
 * all, on a route whose entire design is that it can be called again.
 *
 * The same fact decides what happens when the removal fails: the session is deliberately **kept**.
 * It is the only credential the person has left to finish with, and it grants nothing - the
 * account check refuses this subject on every route but this one and `POST`.
 */

import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { domainError, type DomainError, type Instant } from '@kynviora/domain';
import { hasFreshStepUp, type RequestContext } from './context.js';
import { bearerTokenOf } from './supabaseAuth.js';
import type { UnprovisionedRoute } from './account.js';

// ---------------------------------------------------------------------------
// The provider, behind ports
// ---------------------------------------------------------------------------

export interface ProviderIdentity {
  readonly email: string;
  /** When the provider says the address was confirmed, or `null` where it says it was not. */
  readonly emailVerifiedAt: Instant | null;
}

/**
 * Reading the caller's own record at the provider.
 *
 * A port rather than a fetch, for the reason every other external dependency here is one: a test
 * that had to stand up an identity provider to check a registration rule would be testing the
 * provider.
 */
export interface AuthDirectory {
  read(bearerToken: string): Promise<ProviderIdentity | null>;
}

export type IdentityRemoval = 'REMOVED' | 'ALREADY_ABSENT' | 'FAILED';

/**
 * Ending a session and ending an identity, which need different credentials and so are different
 * methods.
 *
 * `signOutEverywhere` uses the **caller's own** token and needs nothing privileged.
 * `removeIdentity` needs a privilege no client may hold, and {@link canRemoveIdentity} says
 * whether this deployment can perform it at all - checked before anything is written, so a
 * deployment that cannot refuses the whole request rather than doing the half it can.
 *
 * WHY IT TAKES THE TOKEN AS WELL AS THE SUBJECT
 * Because the two ways of doing it need different things. A service-role key names the subject
 * and deletes it. The `close-identity` Edge Function is driven by the **caller's own token** -
 * it reads the subject from the claims Supabase's gateway has already verified, so there is no
 * user id in the request and therefore no way for it to remove anybody but the caller. That is
 * the safer shape, so it is the one preferred where both are configured.
 */
export interface RemovableIdentity {
  readonly subject: string;
  readonly bearerToken: string;
}

export interface AuthIdentityAdmin {
  readonly canRemoveIdentity: boolean;
  signOutEverywhere(bearerToken: string): Promise<boolean>;
  removeIdentity(identity: RemovableIdentity): Promise<IdentityRemoval>;
}

export interface AuthProvider {
  readonly directory: AuthDirectory;
  readonly admin: AuthIdentityAdmin;
}

export interface SupabaseProviderOptions {
  /** `https://<ref>.supabase.co/auth/v1`. */
  readonly issuer: string;
  /** The publishable key. Not a secret: it identifies the project and grants nothing. */
  readonly anonKey: string;
  /**
   * The service-role key, where a deployment has one.
   *
   * A real secret. `14` keeps it server-side; it is never logged, never returned and never sent
   * anywhere but the provider. Optional, and on `kynviora-dev` absent - see below.
   */
  readonly serviceKey?: string | undefined;
  /**
   * The `close-identity` Edge Function, where a deployment has one.
   *
   * The way a removal happens **without this process ever holding a service-role key**. Supabase
   * injects that key into an Edge Function's own environment, so the credential does its job
   * without leaving the platform that issued it - which is what `14` wants and what a key pasted
   * into an environment file is not. It is preferred over `serviceKey` where both are set,
   * because the function derives the subject from the caller's verified token and so cannot
   * remove anybody else.
   */
  readonly deletionFunctionUrl?: string | undefined;
  /**
   * A shared secret the function requires, where one is configured on both sides.
   *
   * Without it, any client holding its own token could call the function directly and remove its
   * identity while Kynviora had stamped nothing - leaving rows nothing can reach. Optional
   * because it is set on the function with `supabase secrets set`, and the function checks it
   * only when it has one.
   */
  readonly deletionSecret?: string | undefined;
  fetchImpl?: typeof fetch;
}

/** The Supabase implementation of both ports. */
export function supabaseAuthProvider(options: SupabaseProviderOptions): AuthProvider {
  const base = options.issuer.replace(/\/$/, '');
  const doFetch = options.fetchImpl ?? fetch;
  const serviceKey = options.serviceKey ?? '';
  const deletionFunctionUrl = options.deletionFunctionUrl ?? '';
  const deletionSecret = options.deletionSecret ?? '';

  return {
    directory: {
      async read(bearerToken: string): Promise<ProviderIdentity | null> {
        const response = await doFetch(`${base}/user`, {
          headers: { apikey: options.anonKey, authorization: `Bearer ${bearerToken}` },
        });
        if (!response.ok) return null;
        const body = (await response.json()) as {
          email?: unknown;
          email_confirmed_at?: unknown;
        };
        const email = typeof body.email === 'string' ? body.email.trim() : '';
        if (email === '') return null;
        const confirmed =
          typeof body.email_confirmed_at === 'string' && body.email_confirmed_at !== ''
            ? (body.email_confirmed_at as Instant)
            : null;
        return { email, emailVerifiedAt: confirmed };
      },
    },
    admin: {
      canRemoveIdentity: serviceKey !== '' || deletionFunctionUrl !== '',
      async signOutEverywhere(bearerToken: string): Promise<boolean> {
        // `scope=global` revokes every session this person has anywhere, not only the one that
        // asked. It is authenticated by their own token, so it needs no privilege at all - which
        // is what makes it the part of a deletion that works today.
        const response = await doFetch(`${base}/logout?scope=global`, {
          method: 'POST',
          headers: {
            apikey: options.anonKey,
            authorization: `Bearer ${bearerToken}`,
            'content-type': 'application/json',
          },
          body: '{}',
        });
        return response.status === 204 || response.ok;
      },
      async removeIdentity(identity: RemovableIdentity): Promise<IdentityRemoval> {
        // The function first: it needs no secret in this process, and it cannot be asked to
        // remove anybody but whoever the token belongs to.
        if (deletionFunctionUrl !== '') {
          const headers: Record<string, string> = {
            apikey: options.anonKey,
            authorization: `Bearer ${identity.bearerToken}`,
            'content-type': 'application/json',
          };
          if (deletionSecret !== '') headers['x-kynviora-deletion'] = deletionSecret;
          const answer = await doFetch(deletionFunctionUrl, {
            method: 'POST',
            headers,
            body: '{}',
          });
          // The function answers 204 both when it removed the identity and when it found it
          // already absent, because from here those are the same outcome: it is gone.
          return answer.status === 204 || answer.ok ? 'REMOVED' : 'FAILED';
        }

        if (serviceKey === '') return 'FAILED';
        const response = await doFetch(`${base}/admin/users/${identity.subject}`, {
          method: 'DELETE',
          headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
        });
        if (response.ok) return 'REMOVED';
        // Already gone is done. A retry after a partial failure must not fail on the step that
        // already succeeded, or the retry can never complete.
        if (response.status === 404) return 'ALREADY_ABSENT';
        return 'FAILED';
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface AccountRouteDeps {
  readonly contextFor: (
    request: FastifyRequest,
    reply: FastifyReply,
    unprovisioned?: UnprovisionedRoute,
  ) => Promise<RequestContext | null>;
  readonly fail: (reply: FastifyReply, error: DomainError, correlationId: string) => FastifyReply;
  /** Absent where this deployment has no identity provider - the development authenticator. */
  readonly provider: AuthProvider | null;
}

const registerBodySchema = z.object({}).strict();

interface AccountRow {
  readonly id: string;
  readonly email_normalized: string;
  readonly email_verified_at: string | null;
  readonly status: string;
  readonly created_at: string;
}

function accountView(row: AccountRow): Record<string, unknown> {
  return {
    userId: row.id,
    email: row.email_normalized,
    emailVerified: row.email_verified_at !== null,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function registerAccountRoutes(app: FastifyInstance, deps: AccountRouteDeps): void {
  const { contextFor, fail, provider } = deps;

  /**
   * Who the caller is, as this system holds them.
   *
   * Not exempt from the account check, because there is nothing here to say to somebody who has
   * no account: `POST` is how they get one, and a `GET` answering "you have no account" would be
   * the oracle DEC-124 declined to build.
   */
  app.get('/v1/me', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;
    const found = await ctx.db((db) =>
      db.query<AccountRow>(
        `SELECT id, email_normalized, email_verified_at, status, created_at
           FROM app_user WHERE id = kynviora.current_user_id()`,
      ),
    );
    const row = found.rows[0];
    // Unreachable while the account check stands, and asserted rather than assumed: if the two
    // ever disagreed, this would be the route that served a null.
    if (row === undefined) {
      return fail(reply, domainError('UNAUTHENTICATED', 'No valid session.'), ctx.correlationId);
    }
    return reply.send({ account: accountView(row), serverTime: ctx.now });
  });

  /**
   * Turn a verified subject into an account.
   *
   * Idempotent by nature rather than by an idempotency key: the subject is the identity, so a
   * second call finds the row the first one made and returns it. There is nothing a caller could
   * vary between two calls, which is why the body is `.strict()` and empty - a body with fields
   * in it would be a caller describing themselves.
   */
  app.post('/v1/me', async (request, reply) => {
    const ctx = await contextFor(request, reply, 'REGISTER_ACCOUNT');
    if (!ctx) return;

    if (!registerBodySchema.safeParse(request.body ?? {}).success) {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'This request takes no fields.'),
        ctx.correlationId,
      );
    }

    const existing = await ctx.db((db) =>
      db.query<AccountRow>(
        `SELECT id, email_normalized, email_verified_at, status, created_at
           FROM app_user WHERE id = kynviora.current_user_id() AND deleted_at IS NULL`,
      ),
    );
    const already = existing.rows[0];
    if (already !== undefined) {
      return reply.status(200).send({ account: accountView(already), serverTime: ctx.now });
    }

    const token = bearerTokenOf(request);
    if (provider === null || token === null) {
      // The development authenticator has no provider to ask, and an account provisioned without
      // one would carry an email nobody had verified - which is the thing DEC-118 requires and
      // this route exists to enforce. The seed makes development accounts instead.
      return fail(
        reply,
        domainError(
          'PROVIDER_UNAVAILABLE',
          'Registration needs an identity provider. This deployment has none.',
        ),
        ctx.correlationId,
      );
    }

    const identity = await provider.directory.read(token);
    if (identity === null) {
      return fail(
        reply,
        domainError(
          'PROVIDER_UNAVAILABLE',
          'Could not read your account from the sign-in service.',
        ),
        ctx.correlationId,
      );
    }
    if (identity.emailVerifiedAt === null) {
      // DEC-118 chose verified email and password. An unverified address is a person who has not
      // finished signing up, and the refusal says which - this one is safe to distinguish,
      // because the caller already holds a token for the subject it is about.
      return fail(
        reply,
        domainError('EMAIL_NOT_VERIFIED', 'Confirm your email address before continuing.'),
        ctx.correlationId,
      );
    }

    const email = identity.email.trim().toLowerCase();

    const created = await ctx.privileged('ACCOUNT_REGISTRATION', async (db) => {
      const inserted = await db.query<AccountRow>(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING
         RETURNING id, email_normalized, email_verified_at, status, created_at`,
        [ctx.principal.userId, ctx.principal.userId, email, identity.emailVerifiedAt],
      );
      const row = inserted.rows[0];
      if (row === undefined) return null;

      // `20`: the actor, the target and a machine code. Not the address - an audit log is the one
      // place a purged identifier could come back from.
      await db.query(
        `INSERT INTO audit_event
           (actor_user_id, actor_role, action, target_kind, target_id, correlation_id, detail)
         VALUES ($1, 'kynviora_service', 'account.registered', 'app_user', $1, $2, $3::jsonb)`,
        [ctx.principal.userId, ctx.correlationId, JSON.stringify({ email_verified: true })],
      );
      return row;
    });

    if (created === null) {
      // `ON CONFLICT DO NOTHING` returned nothing, so a row for this subject exists and the read
      // above did not see it - which means it is stamped deleted. A subject cannot re-register
      // into a deleted account: the row is retained on an approved basis until the purge takes it
      // (DEC-117), and reviving it would resurrect everything that hung off it.
      return fail(
        reply,
        domainError('ACCOUNT_CLOSED', 'This account has been closed.'),
        ctx.correlationId,
      );
    }

    return reply.status(201).send({ account: accountView(created), serverTime: ctx.now });
  });

  /**
   * Remove the account, everything under it, and the identity behind it (`DEV-062`).
   *
   * Exempt from the account check, so a deletion interrupted part-way can be finished by the
   * person it belongs to rather than only by an operator. Every step is idempotent and the whole
   * route can be called again safely.
   */
  app.delete('/v1/me', async (request, reply) => {
    const ctx = await contextFor(request, reply, 'REGISTER_ACCOUNT');
    if (!ctx) return;

    if (!hasFreshStepUp(ctx)) {
      // `14` names account deletion among the actions that require re-authentication, and this is
      // the most one-way of them.
      return fail(
        reply,
        domainError('STEP_UP_REQUIRED', 'Confirm your identity before deleting your account.'),
        ctx.correlationId,
      );
    }

    const token = bearerTokenOf(request);
    if (provider === null || token === null) {
      return fail(
        reply,
        domainError(
          'PROVIDER_UNAVAILABLE',
          'Account deletion needs an identity provider. This deployment has none.',
        ),
        ctx.correlationId,
      );
    }

    // **Before anything is written.** A deployment that cannot remove the identity must not
    // perform the half it can: that is the half-measure DEC-120 refused, and checking first is
    // what makes it impossible rather than merely discouraged.
    if (!provider.admin.canRemoveIdentity) {
      return fail(
        reply,
        domainError(
          'PROVIDER_UNAVAILABLE',
          'Account deletion is not available on this deployment. Nothing has been changed.',
        ),
        ctx.correlationId,
      );
    }

    // 1. Local, and idempotent. Everything under the account is stamped in one transaction, so a
    //    failure leaves nothing half-revoked - and a second call over an already-stamped account
    //    stamps nothing and carries on to the steps that did not finish.
    const stamped = await ctx.privileged('ACCOUNT_DELETION', async (db) => {
      const profiles = await db.query<{ id: string }>(
        `SELECT id FROM profile WHERE owner_user_id = $1 AND deleted_at IS NULL`,
        [ctx.principal.userId],
      );
      for (const profile of profiles.rows) {
        // The same function the profile route calls, which stamps the profile **and every live
        // item under it** in one call - `0023` reaches a dose event's purge door through
        // `owned_item.deleted_at`, so a profile-only stamp leaves rows visible to the sweep and
        // undeletable (DEC-120).
        await db.query('SELECT kynviora.delete_profile($1, $2)', [
          profile.id,
          ctx.principal.userId,
        ]);
      }

      const account = await db.query<{ id: string }>(
        `UPDATE app_user
            SET deleted_at = now(), status = 'DELETED'
          WHERE id = $1 AND deleted_at IS NULL
        RETURNING id`,
        [ctx.principal.userId],
      );
      const first = account.rows.length === 1;

      if (first) {
        await db.query(
          `INSERT INTO audit_event
             (actor_user_id, actor_role, action, target_kind, target_id, correlation_id, detail)
           VALUES ($1, 'kynviora_service', 'account.deleted', 'app_user', $1, $2, $3::jsonb)`,
          [
            ctx.principal.userId,
            ctx.correlationId,
            // Counts, never names. `16` retains the record **that** a deletion happened for 24
            // months (DEC-117), and that record must not become a description of what was deleted.
            JSON.stringify({ profile_count: profiles.rows.length }),
          ],
        );
      }
      return { first, profiles: profiles.rows.length };
    });

    // 2. The identity itself, **before** the sessions and not after, which is a reversal.
    //
    //    The removal is driven by the caller's own token (`close-identity` derives the subject
    //    from it, so it cannot be pointed at anybody else) - and a global sign-out invalidates
    //    that token at the provider immediately. Signing out first therefore left the removal
    //    unable to authenticate, on a route whose whole design is that it can be called again.
    //
    //    Idempotent either way: an identity already gone is a removal that succeeded.
    const removal = await provider.admin.removeIdentity({
      subject: ctx.principal.userId,
      bearerToken: token,
    });

    if (removal === 'FAILED') {
      // Deliberately **not** signed out here. The data is stamped and unreachable - DEC-124
      // refuses this subject on every route but this one and `POST`, so the live session grants
      // nothing - and it is the only credential the person still has to finish the job with.
      // Revoking it would make the documented recovery ("try again") impossible.
      // The data is stamped and unreachable and the sessions are gone; what remains is an identity
      // that can still authenticate to a subject with no account - which is a clean 401 rather
      // than a broken success. Recorded so an operator can find it, and the route can simply be
      // called again.
      await ctx.privileged('ACCOUNT_DELETION', (db) =>
        db.query(
          `INSERT INTO audit_event
             (actor_user_id, actor_role, action, target_kind, target_id, correlation_id, detail)
           VALUES ($1, 'kynviora_service', 'account.identity_removal_pending', 'app_user', $1, $2,
                   $3::jsonb)`,
          [
            ctx.principal.userId,
            ctx.correlationId,
            JSON.stringify({ session_kept_for_retry: true }),
          ],
        ),
      );
      return fail(
        reply,
        domainError(
          // Its own code, not the `PROVIDER_UNAVAILABLE` the two refusals above use. Those mean
          // nothing was changed; this means the opposite, and `13` has clients branch on the code
          // rather than on the sentence - so a screen reading "nothing has been changed" over
          // this state would tell somebody their medicines were still there when they were not.
          'ACCOUNT_DELETION_INCOMPLETE',
          'Your data has been removed. Closing your sign-in account did not finish; try again.',
        ),
        ctx.correlationId,
      );
    }

    // 3. Every remaining session, everywhere. Removing the identity already took them with it, so
    //    this is belt and braces for the `ALREADY_ABSENT` path - where the identity was gone
    //    before this call and a session could in principle have outlived it. Best effort: the
    //    account check refuses this subject on the next request either way.
    const signedOut = await provider.admin.signOutEverywhere(token);

    await ctx.privileged('ACCOUNT_DELETION', (db) =>
      db.query(
        `INSERT INTO audit_event
           (actor_user_id, actor_role, action, target_kind, target_id, correlation_id, detail)
         VALUES ($1, 'kynviora_service', 'account.identity_removed', 'app_user', $1, $2, $3::jsonb)`,
        [
          ctx.principal.userId,
          ctx.correlationId,
          JSON.stringify({ outcome: removal, signed_out: signedOut, first: stamped.first }),
        ],
      ),
    );

    return reply.status(204).send();
  });
}
