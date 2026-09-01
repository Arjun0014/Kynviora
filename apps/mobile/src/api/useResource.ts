/**
 * Load one thing from the API into a {@link Resource}.
 *
 * Spec references: `06` (every critical route defines loading / empty / offline / error /
 * authorization-lost states), `12` (client error classes), `18` (never present uncertain
 * information as certain).
 *
 * WHAT THE HOOK IS FOR
 * Every screen needs the same four behaviours and each is easy to get subtly wrong: fetch on
 * mount, not writing state after the screen has gone, refetching on demand, and keeping content
 * on screen honestly labelled when a refresh fails. Written once here, they are the same on every
 * screen; written per screen, the fourth is the one that gets skipped.
 *
 * A FAILED REFRESH DOES NOT SILENTLY LEAVE OLD CONTENT UP
 * If a refetch fails while something is already displayed, the resource becomes `STALE` rather
 * than the failure state - the content stays, and the state says it is older than it looks. The
 * alternatives are both wrong: discarding a medicine list because a refresh timed out takes away
 * something the user was reading, and leaving it up unlabelled presents old information as
 * current, which `18` forbids.
 *
 * AND IT DOES NOT KEEP CONTENT THE SERVER HAS JUST WITHDRAWN
 * That only applies to a failure saying nothing about this caller's access. `refreshedResource`
 * makes the distinction and this hook makes no decision of its own: a revoked caregiver's next
 * read must take the content off the screen, not label it (`15` A2).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  loadingResource,
  refreshedResource,
  type ApiOutcome,
  type Resource,
  type ResourceOptions,
} from '@kynviora/contracts';

export interface UseResourceOptions<T> extends ResourceOptions<T> {
  /**
   * Whether to run at all.
   *
   * For a screen whose request depends on something not loaded yet - the profile ID, usually.
   * A disabled resource stays `LOADING` rather than firing a request it knows is incomplete.
   */
  readonly enabled?: boolean;
}

export interface UseResourceResult<T> {
  readonly resource: Resource<T>;
  /** Re-run the request. Safe to call from a retry control. */
  readonly reload: () => void;
  /** True while a request is in flight, including a refresh over existing content. */
  readonly refreshing: boolean;
}

/**
 * @param load  The request. Must be stable - wrap it in `useCallback` in the caller, keyed on
 *              whatever it closes over, or it re-runs on every render.
 */
export function useResource<T>(
  load: (() => Promise<ApiOutcome<T>>) | null,
  options: UseResourceOptions<T> = {},
): UseResourceResult<T> {
  const [resource, setResource] = useState<Resource<T>>(loadingResource<T>());
  const [refreshing, setRefreshing] = useState(false);

  // Read inside the effect rather than captured in the dependency list, so changing a predicate
  // does not re-fire the request.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Tracks the latest content so a failed refresh can decide between STALE and the failure state
  // without adding `resource` to the effect's dependencies, which would loop.
  const lastValueRef = useRef<T | null>(null);

  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => {
    setGeneration((n) => n + 1);
  }, []);

  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (load === null || !enabled) return;

    // A response arriving after the screen has gone, or after a newer request started, must not
    // be written. Both are the same bug and this is the same guard.
    let live = true;
    setRefreshing(true);

    void load().then(
      (outcome) => {
        if (!live) return;
        setRefreshing(false);

        // The whole decision lives in the contracts package, where it is tested: whether a
        // failure may leave the previous content up is a security question on this screen, not a
        // rendering preference (`15` A2, DEC-041).
        const next = refreshedResource(outcome, lastValueRef.current, optionsRef.current);
        lastValueRef.current = next.value;
        setResource(next);
      },
      () => {
        if (!live) return;
        setRefreshing(false);
        // `request` returns an outcome for every network failure, so reaching here means a
        // programming error - an unsafe URL or a refused session. Surfaced as a recoverable
        // error rather than swallowed, because a screen stuck on LOADING says nothing.
        setResource({
          state: 'RECOVERABLE_ERROR',
          value: null,
          message: null,
          correlationId: null,
        });
      },
    );

    return () => {
      live = false;
    };
  }, [load, enabled, generation]);

  return { resource, reload, refreshing };
}
