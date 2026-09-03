/**
 * How every queueable entity type is sent, registered for as long as the app is running.
 *
 * Spec references: `12` (a pending-operation journal that syncs deterministically), `13` (the
 * operation ID is the idempotency key; per-entity conflict policy), `03` group J, `DEV-038`,
 * `DEV-044`.
 *
 * WHY THIS IS NOT ON THE SCREENS ANY MORE
 * The senders used to live in the screens that queue them - `shelf.tsx` for a schedule,
 * `EditItem.tsx` for an item edit - on the reasoning that the wire call belongs to the code that
 * knows the shape. The shape argument is still right; the *placement* was wrong, and a device
 * showed how. A tab that has never been opened is not mounted, so nothing could send its type,
 * and the launch after a person's phone killed the app - the launch their queued edit was waiting
 * for - ran its drain with an empty registry. The edit then sat until they happened to background
 * and foreground the app while standing on the right tab, with no screen saying so.
 *
 * This is the same argument `_layout.tsx` already makes for the reminder engine: "a sync that only
 * ran when somebody opened a particular tab would stop extending the horizon the moment they
 * stopped visiting it, and the person would find out by not being reminded." A queue that only
 * drained on one tab fails the same way, and worse - a reminder that stops is at least a thing
 * somebody might notice.
 *
 * WHAT IS STILL THE SCREEN'S JOB
 * Deciding to queue. `13`'s per-entity policy, the idempotency key a create must keep (DEC-111),
 * and what the person is told all stay where the edit is made. This file only knows how to put a
 * queued operation on the wire, which is the part that must not depend on where somebody happens
 * to be standing.
 *
 * WHY IT RENDERS NOTHING
 * There is nothing to show. `12`'s "resolvable failure state" - the screen that lists what is
 * waiting and lets somebody act on a conflicted operation - is still missing, and it is tracked as
 * missing (`DEV-038`) rather than half-answered by a component whose real job is registration.
 */

import { useEffect } from 'react';
import type { ItemUpdateBody, ScheduleBody, ScheduleChangeBody } from '@kynviora/contracts';
import { useApi } from '@/api/ApiProvider';
import { usePendingSync } from '@/sync/PendingSyncProvider';

export function PendingSenders() {
  const { client } = useApi();
  const { registerSender } = usePendingSync();

  useEffect(() => {
    if (client === null) return;

    /**
     * A queued schedule change.
     *
     * `CREATE` sends the operation ID as the idempotency key, which is the whole reason the queue
     * keeps the key the failed attempt used (DEC-111): a create that reached the server and lost
     * its answer is committed once rather than twice, and on this table a second row is not a
     * duplicate on a list - it is being told twice, at the same minute, to take the same tablet.
     * `UPDATE` needs no key because it is conditional on `expectedVersion`, so a replay either
     * lands once or comes back as a conflict.
     */
    registerSender('medicine_schedule', async (operation) => {
      if (operation.mutation === 'CREATE') {
        return client.createSchedule(
          operation.entityId,
          operation.payload as ScheduleBody,
          operation.operationId,
        );
      }
      return client.updateSchedule(operation.entityId, operation.payload as ScheduleChangeBody);
    });

    /**
     * A queued item edit, and only an edit.
     *
     * A queued `CREATE` would reach Phase 8.5's reconciliation as a second copy of one medicine
     * (`DEV-038`), so a mutation this was never wired to queue is refused here rather than
     * quietly acquiring a behaviour nobody chose.
     */
    registerSender('owned_item', async (operation) => {
      if (operation.mutation !== 'UPDATE') {
        return {
          kind: 'REFUSED',
          code: 'VALIDATION_FAILED',
          message: 'Unsupported offline change.',
          retryable: false,
          correlationId: null,
        };
      }
      return client.updateItem(operation.entityId, operation.payload as ItemUpdateBody);
    });
  }, [client, registerSender]);

  return null;
}
