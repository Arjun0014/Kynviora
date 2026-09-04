/**
 * The rule that decides what an offline journal is allowed to carry, checked against the app.
 *
 * Spec references: `12` ("only low-risk user-owned changes" may be applied before the server has
 * agreed; a pending-operation journal), `13` (conflict policy per entity type), `11` (safety and
 * authorization are server-authoritative), DEC-110, `DEV-048`.
 *
 * WHY THIS EXISTS SOMEWHERE THAT IS NOT `apps/**`
 * The same reason `mobileGlobals.ts` does. `apps/**` is outside the test run and outside the lint
 * run, so a rule written there is a rule nothing checks - and this is a rule where being wrong is
 * quiet. `PendingSyncProvider.queue` already refuses a type `13` does not allow, so a sender
 * registered for `caregiver_grant` would not queue anything today and nothing would fail. It would
 * simply sit there, correct-looking, until somebody relaxed the refusal for an unrelated reason
 * and a revoked caregiver's queued changes started going out one after another.
 *
 * So the check is on the registration rather than on the queueing: a sender is a statement that
 * this app knows how to send that type, and the types it may say that about are exactly the ones
 * whose conflict policy is not `SERVER_WINS`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not decide that a permitted type **should** be wired. Three of the nine the policy allows
 * have no client feature to queue from and one is refused for a reason of its own; `DEV-048` holds
 * that reasoning, per type, because it is a judgement about the product rather than a rule a
 * scanner can apply.
 */

import {
  CONFLICT_POLICY_BY_ENTITY,
  SYNC_ENTITY_TYPES,
  type SyncEntityType,
} from '@kynviora/domain';

/** How a sender registration reads in the app. */
const REGISTRATION = /registerSender\(\s*'([A-Za-z_]+)'/g;

/**
 * Every entity type the app has registered a sender for.
 *
 * Read out of the source rather than imported, because importing would need the React tree to run
 * and the point is to check the file as written. Duplicates are kept: registering the same type
 * twice is its own defect, and collapsing them here would hide it.
 */
export function registeredSenderTypes(source: string): readonly string[] {
  return [...source.matchAll(REGISTRATION)].map((match) => match[1] ?? '');
}

/** What is wrong with a set of registrations, in sentences somebody can act on. */
export function senderPolicyFailures(types: readonly string[]): readonly string[] {
  const failures: string[] = [];

  for (const type of types) {
    if (!(SYNC_ENTITY_TYPES as readonly string[]).includes(type)) {
      failures.push(
        `A sender is registered for ${JSON.stringify(type)}, which is not a sync entity type. ` +
          'The journal stores the string it was given, so this one would be written and never sent.',
      );
      continue;
    }
    const policy = CONFLICT_POLICY_BY_ENTITY[type as SyncEntityType];
    if (policy === 'SERVER_WINS') {
      failures.push(
        `A sender is registered for ${JSON.stringify(type)}, whose conflict policy is ` +
          'SERVER_WINS. `12` allows only low-risk user-owned changes to be applied before the ' +
          'server has agreed, and this table carries an authorization or safety outcome - a ' +
          'queued one would be shown as done on the strength of nothing.',
      );
    }
  }

  const seen = new Set<string>();
  for (const type of types) {
    if (seen.has(type)) {
      failures.push(
        `Two senders are registered for ${JSON.stringify(type)}. The second replaces the first, ` +
          'so one of them is dead code and which one is decided by the order of two lines.',
      );
    }
    seen.add(type);
  }

  return failures;
}
