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
 *
 * EITHER READ MAY WIN, AND THEY AGREE
 * The stored copy and the request are started together and there is no ordering between them. On
 * a device the request usually answers first, because a connection to a server that is not there
 * fails in milliseconds while opening a SQLCipher database is a round trip through the keystore.
 * So both orders converge on the same answer through `retainsPreviousContent`: whether a failure
 * may leave content on screen, and whether a stored copy may be put there, are the same question.
 *
 * THE LOCAL COPY GOES THROUGH THE SAME RULE
 * `12` requires screens to read local state immediately and `03` group J requires the medicine
 * list to survive being offline, so a caller may name a `projectionKey` and the last successful
 * body for it is read from the encrypted store before the request goes out. It arrives as
 * `STALE`, not `READY`: it is what the server said last time, and a screen that presented it as
 * confirmed would be doing exactly what `18` forbids. When the response lands it replaces the
 * copy, and `projectionActionFor` - derived from the same `retainsPreviousContent` rule that
 * governs the screen - decides whether the row on disk is written, kept or deleted. Deleted is
 * the case that matters: content taken off the screen for an access failure and left on the disk
 * is content a revoked caregiver reads by reopening the app offline.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  loadingResource,
  projectionActionFor,
  refreshedResource,
  retainsPreviousContent,
  staleResource,
  type ApiOutcome,
  type Resource,
  type ResourceOptions,
} from '@kynviora/contracts';
import { projectionKey } from '@kynviora/contracts';
import { useProjection } from '@/storage/ProjectionProvider';

export interface UseResourceOptions<T> extends ResourceOptions<T> {
  /**
   * Whether to run at all.
   *
   * For a screen whose request depends on something not loaded yet - the profile ID, usually.
   * A disabled resource stays `LOADING` rather than firing a request it knows is incomplete.
   */
  readonly enabled?: boolean;
  /**
   * A name for this read in the encrypted local store, or absent for a read that is not kept.
   *
   * Opt-in per call site rather than on by default, because what may live on the device is a
   * decision about that content and not about caching in general. It must include everything the
   * request varies by - a filter left out of the key is one screen reading another's rows.
   */
  readonly projectionKey?: string;
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
  const { projection, sessionId } = useProjection();

  // Read inside the effect rather than captured in the dependency list, so changing a predicate
  // does not re-fire the request.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Tracks the latest content so a failed refresh can decide between STALE and the failure state
  // without adding `resource` to the effect's dependencies, which would loop.
  const lastValueRef = useRef<T | null>(null);

  /**
   * The last failure, or `null` while nothing has failed.
   *
   * Needed because the two reads race and either can win. Opening a SQLCipher database means a
   * round trip through the keystore, and a request to a server that is not there fails in
   * milliseconds - so on a device the *network* answer usually arrives first, and the stored copy
   * lands afterwards with a failure already on screen. Without this the local content was simply
   * dropped, which is the whole of `03` group J not working while looking like it did.
   */
  const lastFailureRef = useRef<Exclude<ApiOutcome<T>, { kind: 'OK' }> | null>(null);

  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => {
    setGeneration((n) => n + 1);
  }, []);

  const enabled = options.enabled ?? true;

  const storedKey = options.projectionKey;
  const key =
    projection === null || storedKey === undefined ? null : projectionKey(sessionId, storedKey);

  /** The response the store still has to be told about, once it is open. */
  const pendingWriteRef = useRef<ApiOutcome<T> | null>(null);
  const [storeGeneration, setStoreGeneration] = useState(0);

  // Runs when a response arrives *and* when the store finishes opening, so whichever is second
  // completes the write. `projection` is a dependency here and deliberately not of the request
  // effect: firing that one again on the store opening would re-read the medicine list on every
  // cold start, for nothing.
  useEffect(() => {
    const outcome = pendingWriteRef.current;
    if (projection === null || key === null || outcome === null) return;
    pendingWriteRef.current = null;

    // `catch` on every one of these, and it is not defensive tidiness. The projection is a copy
    // of the last thing the server said (DEC-100); if the store cannot take the write - a device
    // with no room left, which is `19`'s low-storage scenario - the content on screen is still
    // the server's own answer and is still correct. What must not happen is the failure becoming
    // an **unhandled** rejection, which is what it was: a store made unwritable produced
    // "Uncaught (in promise) ... attempt to write a readonly database" and a LogBox banner across
    // the tab bar (`DEV-055`).
    //
    // Swallowed rather than surfaced, deliberately. There is nothing a person can do about it and
    // nothing about what they are looking at is wrong - the next launch simply has an older copy,
    // which is the same state as a first launch.
    if (outcome.kind === 'OK') {
      void projection.write(key, outcome.value).catch(() => undefined);
      return;
    }
    // Written where the server confirmed it, deleted where the server's answer was about access,
    // and left alone where the server said nothing at all (`12`, `15` A2).
    if (projectionActionFor(outcome) === 'FORGET') {
      void projection.forget(key).catch(() => undefined);
    }
  }, [projection, key, storeGeneration]);

  // Read the local copy before the request goes out. `12`: screens read local state immediately.
  // It lands as STALE rather than READY - it is the last thing the server said, not an answer to
  // this load - and only where nothing is already on screen, so a reload never replaces confirmed
  // content with an older copy of itself.
  useEffect(() => {
    if (projection === null || key === null || !enabled) return;

    let live = true;
    void projection.read<T>(key).then(
      (stored) => {
        if (!live || stored === null || lastValueRef.current !== null) return;

        // Whether a stored copy may be shown is the same question as whether a failed refresh may
        // leave content up, asked in the other order - so it is the same function. `OFFLINE` and
        // `SERVER_ERROR` said nothing about this caller's access and the copy stands; anything
        // else was an answer, and the answer was no. The row is being deleted for those cases
        // anyway (`projectionActionFor`), and this is what stops a read that was already in
        // flight from rendering it in the meantime.
        const failure = lastFailureRef.current;
        if (failure !== null && !retainsPreviousContent(failure)) return;

        // A stored response that is empty is not content, and `STALE` over nothing would put a
        // "this is older than it looks" label on a screen with nothing on it. The same predicate
        // the live response goes through decides it.
        //
        // It runs inside a try because the predicate reaches into the body - `value.items.length`
        // - and a body that is not the shape this screen expects makes it throw. That is a real
        // case rather than a defensive flourish: a build that changes a response shape reads back
        // rows written by the one before it. Discarding is the only safe answer, because a value
        // the screen cannot interpret is one it must not render; throwing here rejected a promise
        // nothing was handling, which on a device is a blank screen with a red box over it.
        try {
          if (optionsRef.current.isEmpty?.(stored) === true) return;
        } catch {
          return;
        }

        lastValueRef.current = stored;
        setResource(staleResource(stored));
      },
      () => {
        // A store that will not read is the same outcome as an empty one. The request is already
        // in flight and will say what it says.
      },
    );

    return () => {
      live = false;
    };
  }, [projection, key, enabled, generation]);

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
        lastFailureRef.current = outcome.kind === 'OK' ? null : outcome;

        const next = refreshedResource(outcome, lastValueRef.current, optionsRef.current);
        lastValueRef.current = next.value;
        setResource(next);

        // And the same decision reaches the disk.
        // Handed to an effect rather than written here, because the store may not be open yet.
        // Opening a SQLCipher database is a round trip through the keystore and a loopback
        // request is not, so on a device the response routinely wins - and writing inline meant
        // the very first fill was dropped, leaving an empty store that looked like a working one.
        pendingWriteRef.current = outcome;
        setStoreGeneration((n) => n + 1);
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
