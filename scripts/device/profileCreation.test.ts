/**
 * The profile-creation judgements, run with nothing attached (DEC-102).
 *
 * Each test names the wrong answer it prevents. Two of them are wrong answers this scenario has
 * actually produced on the emulator, and both looked like findings about the app.
 */

import { describe, expect, it } from 'vitest';
import {
  profileCreatedCheck,
  profileFormCheck,
  profilePreconditionCheck,
  profileVisibleCheck,
  type ServerProfile,
} from './profileCreation.js';

const HOUSEHOLD = '00000000-0000-4000-8000-00000000d010';

function profile(name: string, overrides: Partial<ServerProfile> = {}): ServerProfile {
  return {
    id: `00000000-0000-4000-8000-${name.length.toString().padStart(12, '0')}`,
    householdId: HOUSEHOLD,
    displayName: name,
    isManaged: true,
    isOwner: true,
    ...overrides,
  };
}

describe('PRO-0, the control', () => {
  it('is inconclusive when somebody already has that name', () => {
    // Profiles cannot be deleted, so every earlier run is still in the household. Without this,
    // "a profile by that name exists" would be answered by last week.
    const check = profilePreconditionCheck({
      before: [profile('Synthetic Relative D')],
      intendedName: 'Synthetic Relative D',
    });
    expect(check.status).toBe('INCONCLUSIVE');
    expect(check.detail).toContain('previous run');
  });

  it('is inconclusive when the list could not be read', () => {
    expect(profilePreconditionCheck({ before: null, intendedName: 'X' }).status).toBe(
      'INCONCLUSIVE',
    );
  });

  it('passes when the name is new to the household', () => {
    expect(
      profilePreconditionCheck({
        before: [profile('Development profile')],
        intendedName: 'Synthetic Relative D',
      }).status,
    ).toBe('PASS');
  });
});

describe('PRO-1, the form', () => {
  it('names the step that did not happen', () => {
    const check = profileFormCheck({
      steps: [
        ['open the You tab', true],
        ['open the add-a-person form', false],
      ],
      nameHeld: null,
      intendedName: 'A',
    });
    expect(check.status).toBe('INCONCLUSIVE');
    expect(check.detail).toContain('open the add-a-person form');
  });

  it('is inconclusive when only part of the name arrived', () => {
    // Measured: `adb shell input text` stops at the first space, so "Synthetic Relative D" reached
    // the form as "Synthetic" and the save looked like a form that refused a valid name.
    const check = profileFormCheck({
      steps: [['open the You tab', true]],
      nameHeld: 'Synthetic',
      intendedName: 'Synthetic Relative D',
    });
    expect(check.status).toBe('INCONCLUSIVE');
    expect(check.detail).toContain('space');
  });

  it('passes when every step happened and the field holds the whole name', () => {
    expect(
      profileFormCheck({
        steps: [['open the You tab', true]],
        nameHeld: 'Synthetic Relative D',
        intendedName: 'Synthetic Relative D',
      }).status,
    ).toBe('PASS');
  });
});

describe('PRO-2, the server', () => {
  const before = [profile('Development profile')];

  it('fails when nothing reached the server', () => {
    const check = profileCreatedCheck({
      before,
      after: before,
      intendedName: 'Synthetic Relative D',
      householdId: HOUSEHOLD,
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('produced nothing');
  });

  it('fails on two people where one save was made', () => {
    const check = profileCreatedCheck({
      before,
      after: [...before, profile('Synthetic Relative D'), profile('Synthetic Relative D')],
      intendedName: 'Synthetic Relative D',
      householdId: HOUSEHOLD,
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('idempotency key');
  });

  it('fails when something other than this person also changed', () => {
    const check = profileCreatedCheck({
      before,
      after: [...before, profile('Synthetic Relative D'), profile('Someone else')],
      intendedName: 'Synthetic Relative D',
      householdId: HOUSEHOLD,
    });
    expect(check.status).toBe('FAIL');
  });

  it('does not count a profile in another household', () => {
    const check = profileCreatedCheck({
      before,
      after: [...before, profile('Synthetic Relative D', { householdId: 'other' })],
      intendedName: 'Synthetic Relative D',
      householdId: HOUSEHOLD,
    });
    expect(check.status).toBe('FAIL');
  });

  it('passes on exactly one, in the right household, with the list grown by one', () => {
    expect(
      profileCreatedCheck({
        before,
        after: [...before, profile('Synthetic Relative D')],
        intendedName: 'Synthetic Relative D',
        householdId: HOUSEHOLD,
      }).status,
    ).toBe('PASS');
  });
});

describe('PRO-3, what the person can see', () => {
  it('fails when the server has them and the page does not', () => {
    // The half no API test can reach: a row nobody can see is not, to the person who made it, a
    // profile that was created - they would add the same person again.
    const check = profileVisibleCheck({
      foundOnScreen: false,
      intendedName: 'Synthetic Relative D',
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('did not reload');
  });

  it('passes when the name was found on the page', () => {
    expect(
      profileVisibleCheck({ foundOnScreen: true, intendedName: 'Synthetic Relative D' }).status,
    ).toBe('PASS');
  });

  it('is inconclusive when the screen could not be read', () => {
    // Distinct from `false` on purpose: "we looked and it was not there" is a finding about the
    // app, and "we could not look" is not (DEC-102).
    expect(profileVisibleCheck({ foundOnScreen: null, intendedName: 'X' }).status).toBe(
      'INCONCLUSIVE',
    );
  });
});
