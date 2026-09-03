/**
 * What the profile-creation scenario's evidence means.
 *
 * Spec references: `19` ("Profile creation"), `04` Phase 1.2 (a household, the people in it, and a
 * clear distinction between the account holder and somebody they look after), `13` (an idempotency
 * key on a create), `16` (why an age band is asked for), `DEV-040`.
 *
 * Kept apart from the runner so the judgements run in `npm run verify` with nothing attached
 * (DEC-102).
 *
 * WHY THIS SCENARIO IS WORTH A RUN OF ITS OWN NOW
 * It was listed as "built and untested on device" for a reason that turned out to be wrong twice
 * over. It is not untested because it is hard to drive - it is four controls - but because until
 * this session **it could not have worked at all**: both of its idempotency keys came from
 * `crypto.randomUUID()`, which does not exist on Hermes, so pressing "Add this person" threw
 * before it reached the network (`DEV-043`). A green run here is the first evidence that adding a
 * person to a household works on a phone.
 *
 * WHAT IT LEAVES BEHIND, SAID RATHER THAN HIDDEN
 * A profile, permanently. There is no delete: `04` Phase 1.2 has no removal path and the schema
 * grants the app role none, so each run adds a person to the development household and the name
 * carries the run's own suffix to keep them apart. That is fine on a synthetic seed and is the
 * reason this is not something to point at a household somebody uses.
 */

import type { Check } from './analysis.js';

/** A profile as the API reports it. */
export interface ServerProfile {
  readonly id: string;
  readonly householdId: string;
  readonly displayName: string;
  readonly isManaged: boolean;
  readonly isOwner: boolean;
}

// ---------------------------------------------------------------------------
// PRO-0 - the control
// ---------------------------------------------------------------------------

export interface ProfilePreconditionEvidence {
  /** Profiles the server had before anything was driven, or `null` if it could not be read. */
  readonly before: readonly ServerProfile[] | null;
  /** The name this run intends to create. */
  readonly intendedName: string;
}

/**
 * Nobody already has the name this run is about to create.
 *
 * Without it, "a profile with that name exists afterwards" is answered by a previous run rather
 * than by this one - and since profiles cannot be deleted, previous runs are always still there.
 */
export function profilePreconditionCheck(evidence: ProfilePreconditionEvidence): Check {
  const title = 'The household did not already contain the person this run creates';
  if (evidence.before === null) {
    return {
      id: 'PRO-0',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The profile list could not be read, so there is nothing to compare against.',
    };
  }
  const clash = evidence.before.filter(
    (profile) => profile.displayName === evidence.intendedName,
  ).length;
  if (clash > 0) {
    return {
      id: 'PRO-0',
      title,
      status: 'INCONCLUSIVE',
      detail:
        `${String(clash)} profile(s) were already called ${JSON.stringify(evidence.intendedName)}, ` +
        'so a later check for that name would be answered by a previous run.',
    };
  }
  return {
    id: 'PRO-0',
    title,
    status: 'PASS',
    detail:
      `${String(evidence.before.length)} profile(s) existed and none was called ` +
      `${JSON.stringify(evidence.intendedName)}, so anything by that name afterwards came from ` +
      'this run.',
  };
}

// ---------------------------------------------------------------------------
// PRO-1 - the form took what was typed
// ---------------------------------------------------------------------------

export interface FormEvidence {
  /** Each step the run tried, in order, and whether it happened. */
  readonly steps: readonly (readonly [string, boolean])[];
  /** What the name field held when the run had finished typing. */
  readonly nameHeld: string | null;
  readonly intendedName: string;
}

/**
 * The form was reachable and took the name.
 *
 * Reported separately from what the server ended up with, because the two fail for entirely
 * different reasons and the fix for each is in a different place. A form that would not take a
 * name is this app's problem; a name that never reached the server is the network's or the route's.
 */
export function profileFormCheck(evidence: FormEvidence): Check {
  const title = 'The add-a-person form was reachable and took the name';
  const failed = evidence.steps.find(([, happened]) => !happened);
  if (failed !== undefined) {
    return {
      id: 'PRO-1',
      title,
      status: 'INCONCLUSIVE',
      detail: `Could not ${failed[0]}, so no profile was ever submitted.`,
    };
  }
  if (evidence.nameHeld !== evidence.intendedName) {
    return {
      id: 'PRO-1',
      title,
      status: 'INCONCLUSIVE',
      detail:
        `The name field held ${evidence.nameHeld === null ? 'nothing readable' : JSON.stringify(evidence.nameHeld)} ` +
        `rather than ${JSON.stringify(evidence.intendedName)}. On this emulator that has meant a ` +
        'space ending the `input text` argument, or the stylus tutorial taking the keystrokes.',
    };
  }
  return {
    id: 'PRO-1',
    title,
    status: 'PASS',
    detail: `Every step was taken and the field held ${JSON.stringify(evidence.nameHeld)}.`,
  };
}

// ---------------------------------------------------------------------------
// PRO-2 - the server has the person, once
// ---------------------------------------------------------------------------

export interface ProfileCreatedEvidence {
  readonly after: readonly ServerProfile[] | null;
  readonly before: readonly ServerProfile[] | null;
  readonly intendedName: string;
  /** The household the run added to, so a profile in some other one is not counted. */
  readonly householdId: string;
}

/**
 * Exactly one person by that name, in the household the run was adding to.
 *
 * "Exactly one" rather than "at least one" because the create carries an idempotency key
 * generated once when the form opens, and a second row would mean it did not do its job - two
 * people in a household who are one person is `04` Phase 8.5's reconciliation problem arriving a
 * stage early.
 */
export function profileCreatedCheck(evidence: ProfileCreatedEvidence): Check {
  const title = 'The person exists on the server, once, in the right household';
  if (evidence.after === null || evidence.before === null) {
    return {
      id: 'PRO-2',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The profile list could not be read after the save.',
    };
  }

  const matching = evidence.after.filter(
    (profile) =>
      profile.displayName === evidence.intendedName && profile.householdId === evidence.householdId,
  );

  if (matching.length === 0) {
    return {
      id: 'PRO-2',
      title,
      status: 'FAIL',
      detail:
        `No profile called ${JSON.stringify(evidence.intendedName)} reached the server. The form ` +
        'accepted the name and the save produced nothing.',
    };
  }
  if (matching.length > 1) {
    return {
      id: 'PRO-2',
      title,
      status: 'FAIL',
      detail:
        `${String(matching.length)} profiles by that name exist. One save has become two people ` +
        'in a household, which is what the idempotency key on the create is for.',
    };
  }
  if (evidence.after.length !== evidence.before.length + 1) {
    return {
      id: 'PRO-2',
      title,
      status: 'FAIL',
      detail:
        `The household went from ${String(evidence.before.length)} profiles to ` +
        `${String(evidence.after.length)}, so something other than this one person changed.`,
    };
  }
  return {
    id: 'PRO-2',
    title,
    status: 'PASS',
    detail:
      `One profile called ${JSON.stringify(evidence.intendedName)} exists in household ` +
      `${evidence.householdId}, and the list grew by exactly one.`,
  };
}

// ---------------------------------------------------------------------------
// PRO-3 - the person can see what they made
// ---------------------------------------------------------------------------

export interface SwitcherEvidence {
  /**
   * Whether the new person was found on the page, **scrolling to look**.
   *
   * Scrolling, not reading the viewport, and the difference is a check that was wrong before it
   * was right. The form returns to a long settings page at whatever scroll position it left, so
   * the switcher at the top is usually not on screen - and the first version of this reported a
   * correct app as having failed to reload its profile list. `null` means the screen could not be
   * read at all, which is not the same as looking and not finding.
   */
  readonly foundOnScreen: boolean | null;
  readonly intendedName: string;
}

/**
 * The new person appears where somebody would look for them.
 *
 * A server row nobody can see is not a created profile from the point of view of the person who
 * created it, and `04` Phase 1.2's switcher is the thing that makes a household with two people in
 * it usable at all. This is the half that no API test can reach.
 */
export function profileVisibleCheck(evidence: SwitcherEvidence): Check {
  const title = 'The new person appears in the app afterwards';
  if (evidence.foundOnScreen === null) {
    return {
      id: 'PRO-3',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The screen could not be read after the form closed.',
    };
  }
  return {
    id: 'PRO-3',
    title,
    status: evidence.foundOnScreen ? 'PASS' : 'FAIL',
    detail: evidence.foundOnScreen
      ? `${JSON.stringify(evidence.intendedName)} is on the page the form returned to, so the ` +
        'person who added them can see and choose them.'
      : `${JSON.stringify(evidence.intendedName)} is on the server and nowhere on the page. The ` +
        'profile list did not reload after the create, so somebody would add the same person ' +
        'again.',
  };
}
