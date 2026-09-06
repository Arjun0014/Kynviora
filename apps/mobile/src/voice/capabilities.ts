/**
 * What the app has been told this caller may do, turned into the set the gates read.
 *
 * Spec references: `11` and `13` (the server decides, every time, on the session), `14` (deny by
 * default), DEC-116, DEC-132. `DEV-074`.
 *
 * THIS AUTHORISES NOTHING
 * Every one of these tools is checked again by the route, on the session, against row-level
 * security. What this decides is only whether the **agent is offered** a tool - the same job
 * `mayRecordDoses` already does on the shelf, where a control the write would refuse is withheld
 * rather than drawn (DEC-045).
 *
 * TWO CASES, AND THE SECOND IS DELIBERATELY NARROW
 *
 * **An owner** holds everything. Ownership is not a grant and is not limited by one; a profile's
 * owner may do anything this app can do to it, and `isOwner` is the signal every screen already
 * gates on.
 *
 * **A caregiver** is offered only what the server has actually reported. There is no route that
 * says "here are this caller's capabilities on this profile" - what exists is `mayRecordDoses` on
 * a shelf page and `mayEdit`/`mayDelete` on an item, each answered with the predicate its own
 * policy applies. So a caregiver gets the read capabilities plus whatever those answered, and
 * anything else is refused by the agent.
 *
 * That is narrower than touch, and it is the safe direction: a caregiver who may edit medicines is
 * told to use the screen, where the control is. The opposite - assuming a capability and letting
 * the route refuse - is a person completing a spoken form for nothing, which is the failure
 * DEC-116's screen half exists to prevent (`DEV-074`).
 */

import type { ToolCapability } from '@kynviora/agent';

export interface CapabilityInputs {
  /** From `listProfiles`. The signal every screen already gates on. */
  readonly isOwner: boolean;
  /** From the shelf page. Absent narrows to `false` (DEC-116). */
  readonly mayRecordDoses?: boolean;
  /** From an item detail, where one has been read. Absent narrows to `false`. */
  readonly mayEditItems?: boolean;
}

/** Every capability an owner holds, which is every capability there is. */
const OWNER_CAPABILITIES: readonly ToolCapability[] = [
  'VIEW_MEDICINES',
  'VIEW_PERSONAL_CARE',
  'RECORD_DOSES',
  'MANAGE_MEDICINES',
  'MANAGE_PERSONAL_CARE',
  'VIEW_ALERTS',
];

/**
 * The reads a caregiver has by construction.
 *
 * A caregiver who could not read anything would not be looking at this profile at all: the shelf
 * and the safety inbox are what a grant is for, and a profile they cannot reach comes back empty
 * rather than refused. Offering the read tools costs nothing - the route answers with what row-
 * level security allows, which for a stranger is nothing.
 */
const CAREGIVER_READS: readonly ToolCapability[] = [
  'VIEW_MEDICINES',
  'VIEW_PERSONAL_CARE',
  'VIEW_ALERTS',
];

export function capabilitiesFor(inputs: CapabilityInputs): ReadonlySet<ToolCapability> {
  if (inputs.isOwner) return new Set(OWNER_CAPABILITIES);

  const held = new Set<ToolCapability>(CAREGIVER_READS);
  // `=== true` rather than a truthiness check, for the reason `shelfView` does it: an older server
  // sends nothing here, and every other shape this could arrive in means the same as absent.
  if (inputs.mayRecordDoses === true) held.add('RECORD_DOSES');
  if (inputs.mayEditItems === true) {
    held.add('MANAGE_MEDICINES');
    held.add('MANAGE_PERSONAL_CARE');
  }
  return held;
}
