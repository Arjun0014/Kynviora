/**
 * Sending the queued edits, in order, and knowing when to stop.
 *
 * Spec references: `12` (pending-operation journal; a resolvable failure state; authorization loss
 * invalidates local access), `13` (sync protocol; bounded retry; the operation ID is the
 * idempotency key), `03` group J, `DEV-038`.
 *
 * WHY STOPPING IS THE HARD PART
 * Draining a queue is a loop. What makes it a rule with a wrong answer is when it ends, and the
 * wrong answers are both silent:
 *
 *   - **Keep going after the network died.** Every remaining operation gets an attempt it could
 *     never have succeeded at. Five queued edits and one dropped tunnel is five operations pushed
 *     towards `MAX_UPLOAD_ATTEMPTS`, and a person who reconnects finds their edits marked as
 *     needing attention rather than simply sent. The attempt budget exists to bound retries of
 *     things that *failed*, not to be spent by one unreachable server.
 *   - **Keep going after authorization ended.** `12` requires authorization loss to invalidate
 *     local access, and continuing to send is a revoked caregiver's remaining edits arriving one
 *     after another. Each will be refused, which is not the point: the point is that they were
 *     sent.
 *
 * Both stop the drain and leave every untried operation exactly as it was - `PENDING`, attempt
 * count untouched, ready for the next drain. Nothing is discarded, because `12` calls a person's
 * change disappearing with nothing said the outcome that must not happen.
 *
 * AND A THIRD ANSWER THAT LOOKS LIKE THE FIRST AND IS NOT
 * An operation whose entity type has **nothing able to send it** has not failed and has not been
 * attempted. In this app a sender belongs to the screen that knows the shape of the write, so on
 * the launch after a person's phone was killed the queue is read before the screen that owns the
 * sender has mounted - which is precisely the launch the journal exists for. Reporting that as
 * `OFFLINE`, as this file's caller first did, costs the operation an attempt for a reason that has
 * nothing to do with the network, marks it `FAILED_RETRYABLE`, and ends the pass so that nothing
 * else is sent either. Repeat that over enough launches and a person's edit reaches
 * `MAX_UPLOAD_ATTEMPTS` and is waiting for somebody to resolve it, having never been sent once.
 *
 * So `canSend` is asked **before** anything is attempted. An operation it refuses is skipped:
 * untouched, full budget, still `PENDING`, and it does not stop the operations behind it - a
 * schedule with no mounted screen must not hold up an item edit that has one. `uploadOrder`'s
 * guarantee survives it, because the dependency it protects ("an update to something created
 * offline is meaningless if the create has not landed") is within one entity type, and this skips
 * whole types rather than individual operations (`DEV-044`).
 *
 * WHAT THIS DOES NOT DECIDE
 * Which operations are eligible (`isUploadable`), what order they go in (`uploadOrder`), what an
 * answer meant (`classifyUpload`), or what it does to a row (`recordUploadOutcome`). All of those
 * exist and are tested; this composes them and owns exactly two decisions of its own: when to stop,
 * and what "could not even be tried" means.
 */

import {
  recordUploadOutcome,
  uploadOrder,
  type OperationId,
  type PendingOperation,
  type SyncEntityType,
} from '@kynviora/domain';
import type { ApiOutcome } from './outcome.js';
import { classifyUpload } from './pendingUpload.js';

/**
 * What a drain did.
 *
 * `stoppedEarly` is reported rather than inferred from the counts, because "nothing left to send"
 * and "stopped because the network went" produce the same numbers when the first operation fails.
 */
export interface DrainResult {
  /** Committed by the server, and safe to delete from the journal. */
  readonly committed: readonly OperationId[];
  /** Written back with a new state and attempt count. */
  readonly updated: readonly PendingOperation[];
  /** Never attempted, because the drain stopped. Left untouched on purpose. */
  readonly untouched: readonly PendingOperation[];
  /**
   * Passed over because nothing could send them, and therefore not attempted either.
   *
   * Separate from `untouched` because the two are answers to different questions. `untouched` is
   * "the drain stopped before reaching these"; this is "the drain reached these and there was no
   * way to send them". Both keep their attempt budget; only this one says the queue is waiting on
   * this app rather than on a server.
   */
  readonly skipped: readonly PendingOperation[];
  /** Why the drain ended, when it ended for a reason other than running out. */
  readonly stoppedEarly: 'OFFLINE' | 'AUTHORIZATION' | null;
}

/** How a drain is told what it is able to send. */
export interface DrainOptions {
  /**
   * Whether an operation of this type can be sent at all right now.
   *
   * Absent means every type can, which is what a caller with one fixed set of senders wants.
   */
  readonly canSend?: (entityType: SyncEntityType) => boolean;
}

/**
 * Whether this answer means there is no point sending anything else this pass.
 *
 * Deliberately narrower than "the attempt failed". A validation refusal is about one edit and says
 * nothing about the next; a dropped connection and a dead session are about the whole queue.
 */
function endsTheDrain(outcome: ApiOutcome<unknown>): 'OFFLINE' | 'AUTHORIZATION' | null {
  switch (outcome.kind) {
    case 'OFFLINE':
      return 'OFFLINE';
    case 'UNAUTHENTICATED':
    case 'AUTHORIZATION_LOST':
      return 'AUTHORIZATION';

    // Listed rather than caught by a `default`, so a new `ApiOutcome` member does not silently
    // acquire "keep going" as its answer. Each of these is about the request that produced it and
    // says nothing about the next one - including `STEP_UP_REQUIRED`, which is about the
    // *operation* needing a fresh confirmation rather than about the session being unusable.
    case 'OK':
    case 'SERVER_ERROR':
    case 'STEP_UP_REQUIRED':
    case 'UNAVAILABLE':
    case 'REFUSED':
      return null;
  }
}

/**
 * Send what is queued, oldest first, and stop when there is no point continuing.
 *
 * `send` performs one upload. It is supplied rather than imported so that the sequencing can be
 * tested without a client, a network or a device - which is the whole reason this is here and not
 * in `apps/**`.
 *
 * A `SERVER_ERROR` does **not** end the drain, and that asymmetry with `OFFLINE` is deliberate: a
 * 500 is about the request that caused it, and one endpoint failing is not evidence that the next
 * one will. It is still retryable, so the operation keeps its place in the queue.
 *
 * An operation that ends the drain is still recorded with its outcome - it was genuinely attempted,
 * and its attempt count should say so. What is left alone is everything *after* it.
 */
export async function drainPendingOperations(
  operations: readonly PendingOperation[],
  send: (operation: PendingOperation) => Promise<ApiOutcome<unknown>>,
  options: DrainOptions = {},
): Promise<DrainResult> {
  const canSend = options.canSend ?? (() => true);
  const queue = uploadOrder(operations);
  const committed: OperationId[] = [];
  const updated: PendingOperation[] = [];
  const skipped: PendingOperation[] = [];

  for (let index = 0; index < queue.length; index += 1) {
    const operation = queue[index];
    if (operation === undefined) continue;

    // Asked before `send`, so an operation nothing can carry is never recorded as attempted.
    // `recordUploadOutcome` increments the attempt count on every outcome it is given, and there
    // is no outcome that means "we did not ask" - which is why this has to be a branch here rather
    // than a classification of an answer nobody received.
    if (!canSend(operation.entityType)) {
      skipped.push(operation);
      continue;
    }

    const outcome = await send(operation);
    const applied = recordUploadOutcome(operation, classifyUpload(outcome));

    if (applied.state === 'COMMITTED') committed.push(applied.operationId);
    else updated.push(applied);

    const stop = endsTheDrain(outcome);
    if (stop !== null) {
      return {
        committed,
        updated,
        untouched: queue.slice(index + 1),
        skipped,
        stoppedEarly: stop,
      };
    }
  }

  return { committed, updated, untouched: [], skipped, stoppedEarly: null };
}
