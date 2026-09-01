/**
 * Choosing what an invitation grants, and holding the token it returns.
 *
 * Spec references: `04` Phase 8.1, `14` (step-up for caregiver administration; an address is
 * personal data), `16` (a caregiver gets exactly what they were granted), DEC-018 (the token is
 * stored only as a hash and is unrecoverable), DEC-019/020 (acceptance never widens a grant, and
 * only the owner may delegate `MANAGE_CAREGIVERS`), trap 11.
 *
 * WHY THE CLIENT MIRRORS THE DELEGATION RULE
 * `canDelegateCapabilities` is the authority and lives in the domain, server-side. This module
 * re-derives which capabilities are *offerable* so the screen does not present a checkbox whose
 * only outcome is `CAPABILITY_ESCALATION`. That is a usability decision, not a security one, and
 * the difference matters: the server would refuse either way, and a caregiver toggling a box the
 * screen should never have shown learns something about the permission model by being refused.
 *
 * WHAT THIS MODULE DOES NOT DO WITH THE TOKEN
 * Nothing. It is not stored, not logged, not put in a URL, not included in any derived value, and
 * not returned by any function here except the one that hands the response straight to the screen.
 * `14` and trap 11 are about a live credential, and the shortest way to keep one out of a log is
 * for no code between the response and the screen to touch it.
 */

import {
  CAREGIVER_CAPABILITIES,
  isCaregiverCapability,
  type CaregiverCapability,
} from '@kynviora/domain';
import type { CaregiverGrant } from './client.js';

/**
 * What the inviter may grant.
 *
 * `OWNER` may grant anything. A caregiver may grant only what they hold, and never
 * `MANAGE_CAREGIVERS` - DEC-020, because a delegated administrator could then widen access in a
 * direction the profile owner would never observe.
 */
export type InviterAuthority =
  | { readonly kind: 'OWNER' }
  | { readonly kind: 'CAREGIVER'; readonly capabilities: readonly CaregiverCapability[] };

export interface CapabilityOption {
  readonly capability: CaregiverCapability;
  /**
   * Whether this capability may be granted by this inviter.
   *
   * Non-offerable capabilities are **absent** from {@link selectableCapabilities} rather than
   * present and disabled. A greyed-out "manage caregivers" box tells a caregiver that the
   * capability exists and that they are not permitted to delegate it, which is a fact about the
   * permission model they did not need.
   */
  readonly offerable: boolean;
}

/** The capabilities this inviter may offer, in the vocabulary's own order. */
export function selectableCapabilities(
  authority: InviterAuthority,
): readonly CaregiverCapability[] {
  if (authority.kind === 'OWNER') return CAREGIVER_CAPABILITIES;

  const held = new Set(authority.capabilities);
  return CAREGIVER_CAPABILITIES.filter(
    (capability) => capability !== 'MANAGE_CAREGIVERS' && held.has(capability),
  );
}

/**
 * What the caller holds on this profile, from the grants the server returned.
 *
 * The union across their own active grants, which is what `kynviora.has_capability` does in SQL -
 * and the reason a merge of two grants for one pair is refused by a unique index rather than
 * being tidied up (trap 10).
 *
 * Their own grants are the ones the server marked `isSelf` (DEC-052). Matching on the grantee's
 * user ID instead would mean reading an identity back out of the session to decide what to put on
 * screen, which in development is a header - a client claim.
 *
 * An expired grant contributes nothing even where its stored status still says `ACTIVE`, because
 * `has_capability` checks `expires_at` separately and a checkbox this screen offered would be
 * refused. `asOf` is the `serverTime` from the response the grants came in, so the comparison uses
 * the clock that produced the rows rather than the device's. This is not an authorization
 * decision - the server decides again on the request - so DEC-024 does not apply; it only keeps
 * the screen from offering a control whose sole outcome is a refusal.
 */
export function heldCapabilities(
  grants: readonly CaregiverGrant[],
  asOf: string,
): readonly CaregiverCapability[] {
  const held = new Set<CaregiverCapability>();

  for (const grant of grants) {
    if (grant.isSelf !== true) continue;
    if (grant.status !== 'ACTIVE') continue;
    if (grant.revokedAt !== null) continue;
    if (grant.expiresAt !== null && grant.expiresAt <= asOf) continue;
    for (const capability of grant.capabilities) {
      if (isCaregiverCapability(capability)) held.add(capability);
    }
  }

  // The vocabulary's own order, so two screens listing the same grant list it the same way.
  return CAREGIVER_CAPABILITIES.filter((capability) => held.has(capability));
}

/**
 * Whether this inviter may send an invitation at all.
 *
 * DEC-045 says a capability this inviter cannot delegate is **absent** from the screen rather than
 * present and disabled, because a greyed-out control states that the capability exists and that
 * this person is not trusted with it. The same reasoning one level up: a caregiver who may
 * delegate nothing should not be offered an invite control whose only reachable outcome is a
 * refusal, having first been asked to fill in a form.
 *
 * A usability decision, not a security one - `authorityOver` decides again server-side, and
 * answers `PERMISSION_DENIED` as a 404. The two conditions are separate on purpose: a caregiver
 * holding only `MANAGE_CAREGIVERS` passes the server's authority check and still has nothing to
 * offer, because DEC-020 forbids them delegating caregiver administration itself.
 */
export function mayInvite(authority: InviterAuthority): boolean {
  if (authority.kind === 'OWNER') return true;
  return (
    authority.capabilities.includes('MANAGE_CAREGIVERS') &&
    selectableCapabilities(authority).length > 0
  );
}

/**
 * Read an inviter's authority from the grants the server returned.
 *
 * A profile the caller owns produces `OWNER`. Otherwise the union of the capabilities on their own
 * active grants - which is what `has_capability` does in SQL, and the reason a merge of two grants
 * for one pair is refused by a unique index (trap 10).
 */
export function inviterAuthority(input: {
  readonly isOwner: boolean;
  readonly ownCapabilities: readonly string[];
}): InviterAuthority {
  if (input.isOwner) return { kind: 'OWNER' };
  return {
    kind: 'CAREGIVER',
    capabilities: input.ownCapabilities.filter(isCaregiverCapability),
  };
}

export type InvitationRefusal =
  | { readonly reason: 'NOTHING_SELECTED'; readonly message: string }
  | {
      readonly reason: 'NOT_OFFERABLE';
      readonly capability: string;
      readonly message: string;
    }
  | { readonly reason: 'INVALID_EMAIL'; readonly message: string };

export interface InvitationDraftResult {
  readonly ok: boolean;
  readonly refusal: InvitationRefusal | null;
  /** The body to send, or `null`. Never carries anything the server would refuse. */
  readonly body: {
    readonly profileId: string;
    readonly capabilities: readonly CaregiverCapability[];
    readonly invitedEmail?: string;
    readonly invitationTtlDays?: number;
  } | null;
}

export const NOTHING_SELECTED_MESSAGE =
  'Choose at least one thing this person can see. An invitation that shares nothing is not worth sending.';

export const INVALID_EMAIL_MESSAGE =
  'That does not look like an email address. Leave it blank to send a link instead.';

/**
 * A permissive shape check, not a validator.
 *
 * The server validates properly and the address is verified on acceptance. This exists only to
 * catch a typo before it becomes a 400, and it is deliberately loose - refusing a real address
 * because a client-side pattern was too strict is a worse failure than sending one the server
 * rejects.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Build the invitation body, or say why it cannot be built.
 *
 * The capability check here is against what this inviter may **offer**, so it cannot produce a
 * request the server would answer with `CAPABILITY_ESCALATION`.
 */
export function buildInvitation(input: {
  readonly profileId: string;
  readonly authority: InviterAuthority;
  readonly selected: readonly string[];
  readonly invitedEmail?: string | null;
  readonly invitationTtlDays?: number;
}): InvitationDraftResult {
  const offerable = new Set<string>(selectableCapabilities(input.authority));

  const chosen: CaregiverCapability[] = [];
  for (const capability of input.selected) {
    if (!offerable.has(capability)) {
      return {
        ok: false,
        refusal: {
          reason: 'NOT_OFFERABLE',
          capability,
          message: 'You cannot share something you do not have yourself.',
        },
        body: null,
      };
    }
    // Duplicates would make the audit record misleading about how many capabilities were granted.
    if (isCaregiverCapability(capability) && !chosen.includes(capability)) chosen.push(capability);
  }

  if (chosen.length === 0) {
    return {
      ok: false,
      refusal: { reason: 'NOTHING_SELECTED', message: NOTHING_SELECTED_MESSAGE },
      body: null,
    };
  }

  const email = input.invitedEmail?.trim();
  if (email !== undefined && email !== '' && !EMAIL_SHAPE.test(email)) {
    return {
      ok: false,
      refusal: { reason: 'INVALID_EMAIL', message: INVALID_EMAIL_MESSAGE },
      body: null,
    };
  }

  return {
    ok: true,
    refusal: null,
    body: {
      profileId: input.profileId,
      capabilities: chosen,
      ...(email === undefined || email === '' ? {} : { invitedEmail: email }),
      ...(input.invitationTtlDays === undefined
        ? {}
        : { invitationTtlDays: input.invitationTtlDays }),
    },
  };
}
