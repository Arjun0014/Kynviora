import { describe, it, expect } from 'vitest';
import { VISIT_PACK_SECTIONS, VISIT_PACK_LIMITATION } from '@kynviora/domain';
import type { VisitPackSection } from '@kynviora/domain';
import {
  ALL_VISIT_PACK_STRINGS,
  SENSITIVE_SHARING_WARNING,
  VISIT_PACK_COPY,
  VISIT_PACK_REVIEW_LIMITATION,
  VISIT_PACK_SECTION_DESCRIPTIONS,
  describeSection,
  summarizeSelection,
} from './visitPack.js';
import { findForbiddenClaims } from './copy.js';

/**
 * Visit Pack review-screen presentation.
 *
 * `06` Journey 8 step 4 makes the review screen a required part of the flow, and `04` Phase 8.4
 * makes "a user can review exactly what will be shared" an exit criterion. That makes the
 * accuracy of this screen a correctness property, not a styling one.
 */

function entries(sections: readonly VisitPackSection[]) {
  return sections.map((section) => ({ section }));
}

describe('section descriptions', () => {
  it('covers every section in the domain vocabulary', () => {
    expect(Object.keys(VISIT_PACK_SECTION_DESCRIPTIONS).sort()).toEqual(
      [...VISIT_PACK_SECTIONS].sort(),
    );
  });

  it('describes each section in a sentence a person can act on', () => {
    for (const section of VISIT_PACK_SECTIONS) {
      const { label, meaning } = describeSection(section);
      expect(label.length).toBeGreaterThan(0);
      expect(meaning.endsWith('.')).toBe(true);
      // No machine codes on a screen someone reads before consenting to share.
      expect(`${label} ${meaning}`).not.toMatch(/[A-Z]{3,}_[A-Z]/);
    }
  });

  it('marks the sections that carry a health inference as sensitive', () => {
    const sensitive = VISIT_PACK_SECTIONS.filter(
      (s) => VISIT_PACK_SECTION_DESCRIPTIONS[s].sensitive,
    );
    // Allergies, open safety items and adherence say something beyond what the person listed:
    // a reaction, a flag Kynviora raised, and a pattern of behaviour.
    expect([...sensitive].sort()).toEqual([
      'ADHERENCE_AND_REFILL',
      'ALLERGIES_AND_SENSITIVITIES',
      'UNRESOLVED_SAFETY_ITEMS',
    ]);
  });
});

describe('review summary', () => {
  it('counts what is included, per section', () => {
    const summary = summarizeSelection(
      entries(['CURRENT_MEDICINES', 'CURRENT_MEDICINES', 'PERSONAL_CARE_ITEMS']),
    );
    expect(summary.included).toEqual([
      { section: 'CURRENT_MEDICINES', label: 'Current medicines', count: 2, sensitive: false },
      {
        section: 'PERSONAL_CARE_ITEMS',
        label: 'Personal-care products',
        count: 1,
        sensitive: false,
      },
    ]);
    expect(summary.totalEntries).toBe(3);
  });

  it('names what is being left out', () => {
    // Spec 18: state the limitation. A person reading only what is included cannot notice what
    // is not.
    const summary = summarizeSelection(entries(['CURRENT_MEDICINES']));
    expect(summary.omitted).toContain('Allergies and sensitivities');
    expect(summary.omitted).toContain('Open safety items');
    expect(summary.omitted).not.toContain('Current medicines');
  });

  it('accounts for every section as either included or omitted', () => {
    const summary = summarizeSelection(entries(['CURRENT_MEDICINES', 'QUESTIONS_AND_NOTES']));
    expect(summary.included.length + summary.omitted.length).toBe(VISIT_PACK_SECTIONS.length);
  });

  it('keeps sections in the order the pack renders them', () => {
    // A review screen listing sections in a different order than the pack would be describing a
    // document the reader is not about to produce.
    const summary = summarizeSelection(
      entries(['QUESTIONS_AND_NOTES', 'ALLERGIES_AND_SENSITIVITIES', 'CURRENT_MEDICINES']),
    );
    expect(summary.included.map((line) => line.section)).toEqual([
      'CURRENT_MEDICINES',
      'ALLERGIES_AND_SENSITIVITIES',
      'QUESTIONS_AND_NOTES',
    ]);
  });

  it('warns when a sensitive section is included', () => {
    const summary = summarizeSelection(entries(['ALLERGIES_AND_SENSITIVITIES']));
    expect(summary.sensitiveWarning).toBe(SENSITIVE_SHARING_WARNING);
    expect(summary.sensitiveWarning).toMatch(/cannot take it back/i);
  });

  it('gives no sensitive warning when nothing sensitive was chosen', () => {
    const summary = summarizeSelection(entries(['CURRENT_MEDICINES', 'PERSONAL_CARE_ITEMS']));
    expect(summary.sensitiveWarning).toBeNull();
  });

  it('states the limitation whatever was selected, including nothing', () => {
    for (const selection of [
      entries([]),
      entries(['CURRENT_MEDICINES']),
      entries([...VISIT_PACK_SECTIONS]),
    ]) {
      expect(summarizeSelection(selection).limitation).toBe(VISIT_PACK_REVIEW_LIMITATION);
    }
  });

  it('describes an empty selection as empty rather than as everything', () => {
    const summary = summarizeSelection(entries([]));
    expect(summary.included).toEqual([]);
    expect(summary.totalEntries).toBe(0);
    expect(summary.omitted).toHaveLength(VISIT_PACK_SECTIONS.length);
  });
});

describe('copy', () => {
  it('contains no forbidden claim', () => {
    for (const text of ALL_VISIT_PACK_STRINGS) {
      expect(findForbiddenClaims(text)).toEqual([]);
    }
  });

  it('previews the same limitation the generated pack carries', () => {
    // Two constants, one sentence. If they drift, the review screen promises a caveat the pack
    // does not print.
    expect(VISIT_PACK_REVIEW_LIMITATION).toBe(VISIT_PACK_LIMITATION);
  });

  it('says plainly that nothing is shared without a choice', () => {
    // Phase 8.4 exit criterion, stated to the user rather than only enforced in the server.
    expect(VISIT_PACK_COPY.chooseIntro).toMatch(/nothing is included until you choose/i);
    expect(VISIT_PACK_COPY.notAutomatic).toMatch(/never shares anything on its own/i);
  });

  it('explains drift without pretending the pack changed', () => {
    // Matching the actual behaviour: the pack is a snapshot of a selection, re-rendered from
    // live records, so a reader is told when those records have moved on (DEC-022).
    expect(VISIT_PACK_COPY.driftNote).toMatch(/changed since the pack was made/i);
  });

  it('does not shame the user for sharing', () => {
    // Spec 18 forbids shaming or fear-driven phrasing, and a person preparing for an appointment
    // has already decided they want their clinician to see this.
    for (const text of ALL_VISIT_PACK_STRINGS) {
      expect(text).not.toMatch(/\b(careful|warning:|beware|risky|dangerous)\b/i);
    }
  });

  it('keeps every sentence short enough to read on a phone', () => {
    for (const text of ALL_VISIT_PACK_STRINGS) {
      for (const sentence of text.split(/(?<=\.)\s+/)) {
        expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(22);
      }
    }
  });
});
