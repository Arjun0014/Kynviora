/**
 * What the app has been told this caller may do, turned into the set the gates read.
 *
 * Spec references: `11` and `13` (the server decides, every time, on the session), `14` (deny by
 * default), DEC-116, DEC-132, DEC-141. `DEV-074`.
 *
 * THIS AUTHORISES NOTHING
 * Every one of these tools is checked again by the route, on the session, against row-level
 * security. What this decides is only whether the **agent is offered** a tool - the same job
 * `mayRecordDoses` already does on the shelf, where a control the write would refuse is withheld
 * rather than drawn (DEC-045).
 *
 * TWO CASES, AND THE SECOND USED TO BE NARROWER THAN THE PERSON WAS
 *
 * **An owner** holds everything. Ownership is not a grant and is not limited by one; a profile's
 * owner may do anything this app can do to it, and `isOwner` is the signal every screen already
 * gates on.
 *
 * **A caregiver** is offered what the **server** says they hold, read from
 * `GET /v1/profiles/:id/capabilities` (DEC-141) - and **nothing else**. Until 2026-09-07 there was
 * no such route, so the only answers available were the ones a screen had happened to fetch -
 * `mayRecordDoses` from a shelf page, `mayEdit` from an item detail - and Voice Mode was
 * constructed with neither. The result was that a caregiver granted `MANAGE_MEDICINES` was told to
 * use the screen for a change they were entirely entitled to make, and a caregiver granted
 * `RECORD_DOSES` could not record a dose by voice at all (`DEV-074`).
 *
 * The three read capabilities used to be added unconditionally, on the reasoning that offering a
 * read costs nothing because row-level security answers an ungranted one with an empty page. That
 * is true and it is not the rule this file now claims: with no report yet, a caregiver holding
 * only `VIEW_SHELF` was offered `list_medicines`, `list_safety_state` and `describe_alert`, and
 * got told there was nothing there about medicines that exist. Deny by default (`14`) is the
 * better answer now that there is something to ask.
 *
 * WHAT IS STILL DELIBERATELY NARROWER BY VOICE, AND WHY
 * Nothing about capabilities. The remaining differences are in the registry rather than here, and
 * each has a reason that is about **voice** rather than about permission: `14` requires a fresh
 * typed identity for the Visit Pack, the export, caregiver administration and closing an account;
 * `delete_item` removes a health record on a misheard word; and `record_consent` records that
 * somebody read a specific versioned text, which a voice interface cannot show anybody. Those are
 * `TOUCH_ONLY` in `packages/agent/src/registry.ts` and are enforced twice - the agent is never
 * told they exist, and the dispatcher refuses one that arrives anyway.
 *
 * WHY AN UNRECOGNISED NAME IS IGNORED RATHER THAN REFUSED
 * The vocabulary belongs to the database. A newer server reporting a capability this build has no
 * tool for is not an error and must not fail the mapping - the mapping is a lookup with no default,
 * so an unknown name contributes nothing and everything else still arrives.
 */

import type { ToolCapability } from '@kynviora/agent';

export interface CapabilityInputs {
  /** From `listProfiles`. The signal every screen already gates on. */
  readonly isOwner: boolean;
  /**
   * What the server reported for this profile, as `caregiver_grant.capabilities` names them.
   *
   * Absent while the answer has not arrived, and it reads the same as empty on purpose: neither is
   * permission (`14`). The cost of the safe direction is that a caregiver who opens Voice Mode
   * before the report lands is offered nothing for one round trip - which is a person told to use
   * the screen, and the screen works.
   */
  readonly granted?: readonly string[];
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
 * The database's vocabulary, mapped onto the agent's.
 *
 * The two are not the same list and should not be. `caregiver_grant.capabilities` is what an owner
 * can grant; `ToolCapability` is what a tool can require, and it names things the grant vocabulary
 * splits differently - `VIEW_SHELF` and `MANAGE_SHELF` are about personal-care products, which the
 * agent calls `VIEW_PERSONAL_CARE` and `MANAGE_PERSONAL_CARE` because that is what the tools are
 * named after.
 *
 * Written as a lookup with no default, so a grant capability with no tool behind it - `VIEW_CARE`,
 * `EXPORT_SUMMARY`, `MANAGE_CAREGIVERS` and the rest - contributes nothing rather than being
 * mapped to something adjacent. Everything they govern is either `OWNER_ONLY` or `TOUCH_ONLY`, and
 * a mapping that guessed would be the one place a caregiver acquired a tool nobody granted them.
 *
 * **A `Map`, not an object literal**, and the reason is the same one that made a hole in the
 * Speech Gate: `Object.freeze` does not remove a prototype, so `FROM_GRANT['constructor']` on an
 * object literal is a function rather than `undefined` - and the names are supplied by a server
 * response. It could not escalate here, because none of those values is a `ToolCapability` and
 * `holdsCapability` only ever asks for a real one; it made the sentence above false, which is
 * enough. A `Map` has no such names.
 */
const FROM_GRANT: ReadonlyMap<string, ToolCapability> = new Map([
  ['VIEW_MEDICINES', 'VIEW_MEDICINES'],
  ['VIEW_SHELF', 'VIEW_PERSONAL_CARE'],
  ['RECORD_DOSES', 'RECORD_DOSES'],
  ['MANAGE_MEDICINES', 'MANAGE_MEDICINES'],
  ['MANAGE_SHELF', 'MANAGE_PERSONAL_CARE'],
  ['VIEW_SAFETY', 'VIEW_ALERTS'],
] satisfies readonly (readonly [string, ToolCapability])[]);

export function capabilitiesFor(inputs: CapabilityInputs): ReadonlySet<ToolCapability> {
  if (inputs.isOwner) return new Set(OWNER_CAPABILITIES);

  const held = new Set<ToolCapability>();
  for (const granted of inputs.granted ?? []) {
    const mapped = FROM_GRANT.get(granted);
    if (mapped !== undefined) held.add(mapped);
  }
  return held;
}
