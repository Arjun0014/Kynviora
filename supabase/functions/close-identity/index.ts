/**
 * Remove the calling person's own sign-in identity, and nothing else (`DEV-062`, DEC-125).
 *
 * Deployed to `kynviora-dev` as the Edge Function `close-identity`. Not part of the Node
 * workspace: it is Deno, it runs on Supabase, and it exists because of one fact about the
 * platform.
 *
 * WHY THIS FUNCTION EXISTS AT ALL
 * Deleting an auth identity needs a service-role credential. `14` keeps that credential
 * server-side, and this deployment has no way to hold one: the key is never handed out by the
 * tooling available here, and a key that had to be pasted into an environment file is a key that
 * gets committed by somebody eventually. Supabase injects `SUPABASE_SERVICE_ROLE_KEY` into every
 * Edge Function's environment by default, so the credential can do its job **without ever leaving
 * the platform that issued it**. That is the whole reason for the indirection, and it is the
 * pattern Supabase documents for user-initiated deletion.
 *
 * THE ONE RULE
 * The subject is read from the **verified token** and never from the request. There is no
 * parameter naming a user, because a function that accepted one would be a way for anybody with
 * any valid token to delete anybody else - which is the single worst thing this could be.
 * `13`'s rule, on a surface that is not even in the same repository.
 *
 * "Verified" is the gateway's doing. `verify_jwt` is on, and Supabase refuses a forged or expired
 * token with 401 before this code runs - measured rather than assumed: a token with real-looking
 * claims and a signature the project never issued is answered `UNAUTHORIZED_LEGACY_JWT` at the
 * edge. So reading `sub` out of the payload here is not the mistake DEC-118 part 6 names; the
 * signature was checked one layer up. The anon key is itself a valid project JWT and the gateway
 * admits it too, so `role` has to be `authenticated` as well - "verified" is not "a person".
 *
 * WHY NOT ASK THE PROVIDER WHO THE TOKEN BELONGS TO
 * Because it stops working at exactly the moment this has to keep working. A deletion that failed
 * after the data was removed must be finishable by the person it belongs to, and by then their
 * session may be gone while their token is still cryptographically valid - so `/auth/v1/user`
 * answers 401 and the retry could never complete. It is still consulted as a cross-check, and
 * only where it answers: if it names a different subject, this refuses.
 *
 * WHAT IT DOES NOT ENFORCE, AND HOW THAT CLOSES
 * It cannot check that Kynviora has already stamped the account: Kynviora's tables are owned by
 * `kynviora_migrate` and granted only to its own three roles, so `service_role` has no privilege
 * on `app_user` at all - which is a deliberate property worth keeping rather than a gap to widen.
 * So a person holding their own valid token could call this directly and remove their identity
 * without Kynviora having stamped anything, leaving a row nothing can reach. Self-inflicted, but
 * it is the ordering DEC-120 cared about.
 *
 * `KYNVIORA_DELETION_SECRET` closes it: when that variable is set on the function, a caller must
 * also present it in `x-kynviora-deletion`, and only Kynviora's API has it. It is checked when
 * present and absent otherwise, so an operator running `supabase secrets set` later closes the
 * gap with no code change and no redeploy of the API. Where it is unset the behaviour is the
 * documented Supabase default, which is what every account-deletion flow on this platform does.
 *
 * ANSWERS
 *   204  the identity is gone - whether this call removed it or found it already absent
 *   401  no token, or one that is not a signed-in person's
 *   403  a deletion secret is configured and the caller did not present it; or the token and the
 *        provider disagree about whose it is
 *   502  the provider refused the removal; the caller may try again
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
/** Optional. Where set, only a caller presenting it may remove an identity. */
const DELETION_SECRET = Deno.env.get('KYNVIORA_DELETION_SECRET') ?? '';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Constant-time comparison, so a wrong secret cannot be found one character at a time.
 *
 * Overkill for a dev project and cheap enough to be unremarkable; the alternative is a string
 * comparison that returns early, which is the thing that gets written into a post-mortem.
 */
function secretMatches(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= presented.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

/** The claims of an already-verified token. Never called on anything the gateway did not admit. */
function claimsOf(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  try {
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') {
    return json(405, { error: 'method_not_allowed' });
  }
  if (SUPABASE_URL === '' || SERVICE_ROLE_KEY === '') {
    // Refuse rather than half-work. A function that cannot remove an identity must say so, so the
    // API's own refusal ("nothing has been changed") stays true.
    return json(500, { error: 'not_configured' });
  }

  if (DELETION_SECRET !== '') {
    const presented = request.headers.get('x-kynviora-deletion') ?? '';
    if (!secretMatches(presented, DELETION_SECRET)) {
      return json(403, { error: 'deletion_secret_required' });
    }
  }

  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : '';
  if (token === '') return json(401, { error: 'no_token' });

  const claims = claimsOf(token);
  const subject = typeof claims?.['sub'] === 'string' ? (claims['sub'] as string) : '';
  if (claims?.['role'] !== 'authenticated' || !UUID.test(subject)) {
    return json(401, { error: 'not_a_user_token' });
  }

  // Cross-check, and only where it answers. A 401 here is the retry case - session gone, token
  // still valid - and must not stop a deletion from being finished.
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, authorization: `Bearer ${token}` },
  });
  if (who.ok) {
    const identity = (await who.json()) as { id?: unknown };
    if (identity.id !== subject) return json(403, { error: 'subject_mismatch' });
  }

  const removed = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${subject}`, {
    method: 'DELETE',
    headers: { apikey: SERVICE_ROLE_KEY, authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });

  // Already gone is done. A retry after a partial failure must not fail on the step that already
  // succeeded, or the retry can never complete.
  if (removed.ok || removed.status === 404) return new Response(null, { status: 204 });
  return json(502, { error: 'removal_failed', status: removed.status });
});
