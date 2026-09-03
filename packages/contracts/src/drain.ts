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
 * WHAT THIS DOES NOT DECIDE
 * Which operations are eligible (`isUploadable`), what order they go in (`uploadOrder`), what an
 * answer meant (`classifyUpload`), or what it does to a row (`recordUploadOutcome`). All of those
 * exist and are tested; this composes them and owns exactly one decision of its own.
 */

import {
  recordUploadOutcome,
  uploadOrder,
  type OperationId,
  type PendingOperation,
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
  /** Why the drain ended, when it ended for a reason other than running out. */
  readonly stoppedEarly: 'OFFLINE' | 'AUTHORIZATION' | null;
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
): Promise<DrainResult> {
  const queue = uploadOrder(operations);
  const committed: OperationId[] = [];
  const updated: PendingOperation[] = [];

  for (let index = 0; index < queue.length; index += 1) {
    const operation = queue[index];
    if (operation === undefined) continue;

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
        stoppedEarly: stop,
      };
    }
  }

  return { committed, updated, untouched: [], stoppedEarly: null };
}
