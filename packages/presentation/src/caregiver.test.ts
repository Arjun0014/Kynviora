import { describe, it, expect } from 'vitest';
import { CAREGIVER_CAPABILITIES, type CaregiverCapability } from '@kynviora/domain';
import {
  ALL_CAREGIVER_STRINGS,
  CAPABILITY_DESCRIPTIONS,
  CAREGIVER_ACCESS_PRESENTATION,
  CAREGIVER_ACCESS_STATES,
  CAREGIVER_COPY,
  describeCapability,
  invitationExpiryNote,
  presentCaregiverAccess,
  summarizeAccess,
} from './caregiver.js';
import { findForbiddenClaims } from './copy.js';
import { ICON_NAMES } from './status.js';
import { LIGHT_THEME, contrastRatio, MIN_BODY_CONTRAST_RATIO } from './tokens.js';

/**
 * Caregiver copy and presentation.
 *
 * Spec 18 makes the wording of a safety-adjacent screen a correctness concern, not a style one.
 * These tests hold the properties that a reviewer would otherwise have to re-check by eye every
 * time a sentence changes.
 */

describe('capability descriptions', () => {
  it('covers every capability in the vocabulary', () => {
    // A total record: adding a capability without writing the sentence a user reads is a
    // compile error, and this asserts the record has not drifted the other way either.
    expect(Object.keys(CAPABILITY_DESCRIPTIONS).sort()).toEqual([...CAREGIVER_CAPABILITIES].sort());
  });

  it('describes each capability as something the caregiver can see or do', () => {
    for (const capability of CAREGIVER_CAPABILITIES) {
      const { meaning } = describeCapability(capability);
      expect(meaning.startsWith('They ')).toBe(true);
      expect(meaning.endsWith('.')).toBe(true);
    }
  });

  it('never leaks a machine code into what a person reads', () => {
    // "MANAGE_MEDICINES" tells a caregiver nothing about what they are approving.
    for (const capability of CAREGIVER_CAPABILITIES) {
      const { label, meaning } = describeCapability(capability);
      expect(`${label} ${meaning}`).not.toMatch(/[A-Z]{3,}_[A-Z]/);
    }
  });

  it('marks exactly the capabilities that permit a change', () => {
    const changing = CAREGIVER_CAPABILITIES.filter((c) => CAPABILITY_DESCRIPTIONS[c].allowsChanges);
    expect([...changing].sort()).toEqual([
      'EXPORT_SUMMARY',
      'MANAGE_CARE',
      'MANAGE_CAREGIVERS',
      'MANAGE_MEDICINES',
      'MANAGE_SHELF',
    ]);
  });

  it('marks only MANAGE_CAREGIVERS as delegating administration', () => {
    const delegating = CAREGIVER_CAPABILITIES.filter(
      (c) => CAPABILITY_DESCRIPTIONS[c].delegatesAdministration,
    );
    expect(delegating).toEqual(['MANAGE_CAREGIVERS']);
  });

  it('treats creating an export as a change, not as viewing', () => {
    // An export leaves the system. Grouping it with read-only access would understate it on the
    // review screen, and spec 14 puts exports behind step-up for the same reason.
    expect(describeCapability('EXPORT_SUMMARY').allowsChanges).toBe(true);
  });
});

describe('access summary', () => {
  it('splits viewing from changing', () => {
    const summary = summarizeAccess(['VIEW_SAFETY', 'MANAGE_MEDICINES']);
    expect(summary.viewing).toEqual([CAPABILITY_DESCRIPTIONS.VIEW_SAFETY.meaning]);
    expect(summary.changing).toEqual([CAPABILITY_DESCRIPTIONS.MANAGE_MEDICINES.meaning]);
  });

  it('states what the access does not include', () => {
    // Spec 18 requires the limitation to be stated. A person reading only the granted list will
    // not notice what was withheld.
    const summary = summarizeAccess(['VIEW_SAFETY']);
    expect(summary.notIncluded).toContain('Medicines');
    expect(summary.notIncluded).toContain('Documents');
    expect(summary.notIncluded).not.toContain('Safety updates');
    expect(summary.viewing).toHaveLength(1);
  });

  it('warns explicitly when administration is being handed over', () => {
    const summary = summarizeAccess(['MANAGE_CAREGIVERS']);
    expect(summary.administrationWarning).toMatch(/invite and remove other caregivers/);
    // And says the decision is reversible, because it is.
    expect(summary.administrationWarning).toMatch(/change this at any time/);
  });

  it('gives no administration warning when it was not granted', () => {
    expect(summarizeAccess(['VIEW_SAFETY', 'VIEW_SHELF']).administrationWarning).toBeNull();
  });

  it('lists every capability as either included or not, with nothing dropped', () => {
    const summary = summarizeAccess(['VIEW_SAFETY', 'MANAGE_SHELF']);
    const described = summary.viewing.length + summary.changing.length + summary.notIncluded.length;
    expect(described).toBe(CAREGIVER_CAPABILITIES.length);
  });

  it('describes an empty grant as granting nothing', () => {
    // Not reachable through the API - the domain refuses an empty capability set - but the
    // summary must not silently describe it as full access if it ever is.
    const summary = summarizeAccess([]);
    expect(summary.viewing).toEqual([]);
    expect(summary.changing).toEqual([]);
    expect(summary.notIncluded).toHaveLength(CAREGIVER_CAPABILITIES.length);
  });
});

describe('access state presentation', () => {
  it('gives every state a label and a shape-distinguishable icon', () => {
    // Spec 18: never communicate meaning through colour alone.
    for (const state of CAREGIVER_ACCESS_STATES) {
      const presentation = presentCaregiverAccess(state);
      expect(presentation.label.length).toBeGreaterThan(0);
      expect(ICON_NAMES).toContain(presentation.iconName);
      expect(presentation.accessibilityLabel.length).toBeGreaterThan(presentation.label.length);
    }
  });

  it('does not distinguish INVITED from ACTIVE by tone alone', () => {
    // The two states with the same tone are the pair a user most needs to tell apart, so the
    // label and icon have to carry it.
    const invited = presentCaregiverAccess('INVITED');
    const active = presentCaregiverAccess('ACTIVE');
    expect(invited.tone).toBe(active.tone);
    expect(invited.label).not.toBe(active.label);
    expect(invited.iconName).not.toBe(active.iconName);
  });

  it('says plainly that an invited caregiver has no access yet', () => {
    // The most consequential misreading on this screen: assuming an invitation is access.
    const invited = presentCaregiverAccess('INVITED');
    expect(invited.description).toMatch(/no access/i);
    expect(invited.accessibilityLabel).toMatch(/no access/i);
  });

  it('presents removing access calmly rather than as an alarm', () => {
    // Spec 02 and 18: a product that styles a normal, encouraged action as a warning discourages
    // the very thing spec 15 wants to be easy.
    for (const state of ['REVOKED', 'DECLINED', 'EXPIRED'] as const) {
      expect(presentCaregiverAccess(state).tone).toBe('neutral');
    }
  });

  it('meets the body contrast minimum in every tone used', () => {
    for (const state of CAREGIVER_ACCESS_STATES) {
      const tone = LIGHT_THEME[presentCaregiverAccess(state).tone];
      expect(contrastRatio(tone.foreground, tone.background)).toBeGreaterThanOrEqual(
        MIN_BODY_CONTRAST_RATIO,
      );
    }
  });
});

describe('flow copy', () => {
  it('contains no forbidden claim', () => {
    for (const text of ALL_CAREGIVER_STRINGS) {
      expect(findForbiddenClaims(text)).toEqual([]);
    }
  });

  it('tells the owner that the link is a bearer credential', () => {
    // A person handing out an invitation link needs to know that is what they are doing.
    expect(CAREGIVER_COPY.linkWarning).toMatch(/anyone who opens this link/i);
    expect(CAREGIVER_COPY.linkShownOnce).toMatch(/shown once/i);
  });

  it('says revocation takes effect straight away', () => {
    // Matching the actual behaviour: `has_capability` re-evaluates per access (spec 15 A2).
    expect(CAREGIVER_COPY.revokeConfirm).toMatch(/straight away/i);
    expect(presentCaregiverAccess('REVOKED').description).toMatch(/straight away/i);
  });

  it('never tells the caregiver to share a sign-in', () => {
    // Spec 15: "no shared passwords" is a control, and the copy must not undermine it.
    expect(CAREGIVER_COPY.inviteIntro).toMatch(/their own account/i);
    for (const text of ALL_CAREGIVER_STRINGS) {
      expect(text).not.toMatch(/share (your|the) (password|sign-in|login)/i);
    }
  });

  it('reads naturally for one day and for several', () => {
    expect(invitationExpiryNote(1)).toBe('The invitation stops working after 1 day.');
    expect(invitationExpiryNote(7)).toBe('The invitation stops working after 7 days.');
  });

  it('keeps every sentence short enough to be read on a phone', () => {
    // Spec 18: one idea per sentence for safety-critical content.
    for (const text of ALL_CAREGIVER_STRINGS) {
      for (const sentence of text.split(/(?<=\.)\s+/)) {
        expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(20);
      }
    }
  });
});

describe('presentation stays in step with the domain', () => {
  it('describes a capability for every value the API will accept', () => {
    // The API validates against CAREGIVER_CAPABILITIES. A capability the API accepts but the UI
    // cannot describe would be granted through a screen that could not say what it does.
    const missing: CaregiverCapability[] = CAREGIVER_CAPABILITIES.filter(
      (c) => !(c in CAPABILITY_DESCRIPTIONS),
    );
    expect(missing).toEqual([]);
  });

  it('has a presentation for every access state', () => {
    expect(Object.keys(CAREGIVER_ACCESS_PRESENTATION).sort()).toEqual(
      [...CAREGIVER_ACCESS_STATES].sort(),
    );
  });
});
