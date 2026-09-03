/**
 * The caregiver invite/revoke judgements, run with nothing attached (DEC-102).
 *
 * The wrong answers these prevent are all the same shape: a scenario that reports working
 * authorization while measuring nothing. Two identities, three moments, and a route that answers
 * "you may not" and "there is nothing" identically by design.
 */

import { describe, expect, it } from 'vitest';
import {
  acceptanceCheck,
  accessLossCheck,
  accessPreconditionCheck,
  invitationCreatedCheck,
  revocationCheck,
} from './caregiverAccess.js';

describe('CAR-0, the control', () => {
  it('is inconclusive when a grant from an earlier run is still active', () => {
    // Grants outlive runs: revoking is the only way to end one, and a crashed run does not revoke.
    const check = accessPreconditionCheck({ beforeInvite: 2, grantsBefore: 1 });
    expect(check.status).toBe('INCONCLUSIVE');
    expect(check.detail).toContain('already active');
  });

  it('fails when the caregiver can read with no grant at all', () => {
    // Not inconclusive. Reading a profile you have no grant for is the failure the whole feature
    // exists to prevent, and it is worth saying so rather than skipping the run.
    const check = accessPreconditionCheck({ beforeInvite: 2, grantsBefore: 0 });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('row-level security');
  });

  it('passes when the caregiver starts with no grant and sees nothing', () => {
    expect(accessPreconditionCheck({ beforeInvite: 0, grantsBefore: 0 }).status).toBe('PASS');
  });
});

describe('CAR-1, the invitation', () => {
  const steps: readonly (readonly [string, boolean])[] = [['open the Care tab', true]];

  it('names the step that did not happen', () => {
    const check = invitationCreatedCheck({
      steps: [
        ['open the Care tab', true],
        ['reach the review step', false],
      ],
      pending: null,
      chosenCapability: 'VIEW_MEDICINES',
    });
    expect(check.status).toBe('INCONCLUSIVE');
    expect(check.detail).toContain('reach the review step');
  });

  it('fails on more than one pending invitation', () => {
    // Each is a live credential anybody holding it may redeem (DEC-018), so a spare one is not
    // untidiness.
    const check = invitationCreatedCheck({
      steps,
      pending: [{ capabilities: ['VIEW_MEDICINES'] }, { capabilities: ['VIEW_MEDICINES'] }],
      chosenCapability: 'VIEW_MEDICINES',
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('live credential');
  });

  it('fails when the invitation carries more than was ticked', () => {
    const check = invitationCreatedCheck({
      steps,
      pending: [{ capabilities: ['VIEW_MEDICINES', 'MANAGE_MEDICINES'] }],
      chosenCapability: 'VIEW_MEDICINES',
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('08.2');
  });

  it('passes on exactly one invitation carrying exactly the chosen capability', () => {
    expect(
      invitationCreatedCheck({
        steps,
        pending: [{ capabilities: ['VIEW_MEDICINES'] }],
        chosenCapability: 'VIEW_MEDICINES',
      }).status,
    ).toBe('PASS');
  });
});

describe('CAR-2, acceptance', () => {
  it('is inconclusive when the owner sees nothing either', () => {
    // A run against an empty household would report a working grant as confidently as a broken one.
    const check = acceptanceCheck({ acceptStatus: 201, afterAccept: 0, ownerSees: 0 });
    expect(check.status).toBe('INCONCLUSIVE');
    expect(check.detail).toContain('nothing for a grant to share');
  });

  it('fails when the grant was made and grants nothing', () => {
    const check = acceptanceCheck({ acceptStatus: 201, afterAccept: 0, ownerSees: 2 });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('both people believe access was given');
  });

  it('fails when the server refused the acceptance', () => {
    expect(acceptanceCheck({ acceptStatus: 404, afterAccept: 0, ownerSees: 2 }).status).toBe(
      'FAIL',
    );
  });

  it('passes when the caregiver can see what the owner shared', () => {
    expect(acceptanceCheck({ acceptStatus: 201, afterAccept: 2, ownerSees: 2 }).status).toBe(
      'PASS',
    );
  });
});

describe('CAR-3, revocation', () => {
  it('fails when the screen said it was removed and the server disagrees', () => {
    const check = revocationCheck({
      steps: [['confirm the removal', true]],
      grantsAfter: 1,
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('has been told it is done');
  });

  it('passes when no grant remains', () => {
    expect(revocationCheck({ steps: [['confirm the removal', true]], grantsAfter: 0 }).status).toBe(
      'PASS',
    );
  });
});

describe('CAR-4, access loss', () => {
  it('is inconclusive when the caregiver saw nothing while granted', () => {
    // Seeing nothing afterwards is only a finding if something changed.
    expect(accessLossCheck({ whileGranted: 0, afterRevocation: 0 }).status).toBe('INCONCLUSIVE');
  });

  it('fails when the caregiver can still read after the removal', () => {
    const check = accessLossCheck({ whileGranted: 2, afterRevocation: 2 });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('straight away');
  });

  it('passes when the very next request returns nothing', () => {
    const check = accessLossCheck({ whileGranted: 2, afterRevocation: 0 });
    expect(check.status).toBe('PASS');
    expect(check.detail).toContain('same session');
  });
});
