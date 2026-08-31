/**
 * Visit Pack presentation: section labels, the review screen, and the sharing warning.
 *
 * Spec references: `06` Journey 8 step 4 ("Review screen shows content and sensitive-sharing
 * warning"), `03` group I, `16` (show what data will be included), `18` (plain language, state
 * the limitation, never meaning through colour alone), `04` Phase 8.4.
 *
 * WHY THE REVIEW SUMMARY IS BUILT, NOT WRITTEN
 * `04` Phase 8.4 requires that a user can review exactly what will be shared. A hand-written
 * summary sentence would drift from the selection the moment either changed, and the drift would
 * be invisible - the screen would still look right. {@link summarizeSelection} derives every
 * number and every section name from the selection itself, so the screen cannot describe an
 * export it is not about to make.
 */

import type { VisitPackSection } from '@kynviora/domain';
import { VISIT_PACK_SECTIONS } from '@kynviora/domain';

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export interface SectionDescription {
  /** Heading on the review screen and on the pack itself. */
  readonly label: string;
  /** One sentence saying what goes in this section. */
  readonly meaning: string;
  /**
   * Whether including this section reveals something a person may not expect to share.
   *
   * Drives the emphasis on the review screen. Marked for the sections that carry a health
   * inference rather than a fact the person volunteered: an open safety item says something was
   * flagged, and an adherence line says something about behaviour.
   */
  readonly sensitive: boolean;
}

/**
 * Every section, described once.
 *
 * A total record: adding a section to the domain vocabulary fails to compile here until someone
 * writes the sentence a person will read before consenting to share it.
 */
export const VISIT_PACK_SECTION_DESCRIPTIONS: Readonly<
  Record<VisitPackSection, SectionDescription>
> = Object.freeze({
  CURRENT_MEDICINES: {
    label: 'Current medicines',
    meaning: 'The medicines recorded as being taken now.',
    sensitive: false,
  },
  PERSONAL_CARE_ITEMS: {
    label: 'Personal-care products',
    meaning: 'Creams, shampoos and similar products on the shelf.',
    sensitive: false,
  },
  ALLERGIES_AND_SENSITIVITIES: {
    label: 'Allergies and sensitivities',
    meaning: 'Reactions that have been recorded, with how certain each one is.',
    sensitive: true,
  },
  UNRESOLVED_SAFETY_ITEMS: {
    label: 'Open safety items',
    meaning: 'Things Kynviora has flagged that have not been resolved yet.',
    sensitive: true,
  },
  RECENT_ITEM_CHANGES: {
    label: 'Recent changes',
    meaning: 'Medicines and products started or stopped recently.',
    sensitive: false,
  },
  ADHERENCE_AND_REFILL: {
    label: 'Doses and refills',
    meaning: 'When medicines are expected to run out, and recorded missed doses.',
    sensitive: true,
  },
  QUESTIONS_AND_NOTES: {
    label: 'Your questions',
    meaning: 'Anything written to raise at the visit.',
    sensitive: false,
  },
});

export function describeSection(section: VisitPackSection): SectionDescription {
  return VISIT_PACK_SECTION_DESCRIPTIONS[section];
}

// ---------------------------------------------------------------------------
// Review summary
// ---------------------------------------------------------------------------

/** One line on the review screen. */
export interface ReviewSectionLine {
  readonly section: VisitPackSection;
  readonly label: string;
  readonly count: number;
  readonly sensitive: boolean;
}

/**
 * What the review screen shows.
 *
 * `included` lists only sections with content; `omitted` names the rest. Both are present because
 * `18` requires the limitation to be stated, and a person reading a list of what is included has
 * no way to notice what is not.
 */
export interface ReviewSummary {
  readonly included: readonly ReviewSectionLine[];
  readonly omitted: readonly string[];
  readonly totalEntries: number;
  /** Present only when the selection includes a section that carries a health inference. */
  readonly sensitiveWarning: string | null;
  /** Always present. Never varied per pack. */
  readonly limitation: string;
}

/**
 * The sensitive-sharing warning `06` Journey 8 step 4 requires.
 *
 * It names what is being shared and what happens next, and does not moralise about the decision:
 * `18` forbids shaming phrasing, and a person preparing for an appointment has already decided
 * they want their clinician to see this.
 */
export const SENSITIVE_SHARING_WARNING =
  'This includes health information. Once you share it, Kynviora cannot take it back.';

/** The pack-level limitation, matching the domain constant this screen previews. */
export const VISIT_PACK_REVIEW_LIMITATION =
  'This summary was prepared by a person using Kynviora. It is not a medical record, and no ' +
  'health professional has checked it.';

export function summarizeSelection(
  entries: readonly { readonly section: VisitPackSection }[],
): ReviewSummary {
  const counts = new Map<VisitPackSection, number>();
  for (const entry of entries) {
    counts.set(entry.section, (counts.get(entry.section) ?? 0) + 1);
  }

  const included: ReviewSectionLine[] = [];
  const omitted: string[] = [];

  // Iterating the vocabulary rather than the map keeps section order stable and matches the
  // order the pack itself is rendered in.
  for (const section of VISIT_PACK_SECTIONS) {
    const description = VISIT_PACK_SECTION_DESCRIPTIONS[section];
    const count = counts.get(section) ?? 0;
    if (count > 0) {
      included.push({
        section,
        label: description.label,
        count,
        sensitive: description.sensitive,
      });
    } else {
      omitted.push(description.label);
    }
  }

  return {
    included,
    omitted,
    totalEntries: entries.length,
    sensitiveWarning: included.some((line) => line.sensitive) ? SENSITIVE_SHARING_WARNING : null,
    limitation: VISIT_PACK_REVIEW_LIMITATION,
  };
}

// ---------------------------------------------------------------------------
// Flow copy
// ---------------------------------------------------------------------------

export const VISIT_PACK_COPY = Object.freeze({
  chooseHeading: 'Choose what to share',
  chooseIntro: 'Nothing is included until you choose it.',
  reviewHeading: 'Check what you are about to share',
  emptySelection: 'Choose at least one thing to include.',
  stepUpPrompt: 'Confirm it is you before creating the pack.',
  changedSinceReview:
    'Something in this list changed while you were looking at it. Check it again before sharing.',
  generatedNote: 'The pack is dated, so a reader can see how current it is.',
  expiredNote: 'This pack has expired. Create a new one to share it again.',
  driftNote:
    'Some of this information has changed since the pack was made. The pack still shows what ' +
    'was there at the time.',
  revokeConfirm:
    'Remove this pack? Anyone you shared the link with will stop being able to open it.',
  notAutomatic: 'Kynviora never shares anything on its own. You choose, then you confirm.',
});

/** Every fixed string here, for the forbidden-claim test. */
export const ALL_VISIT_PACK_STRINGS: readonly string[] = Object.freeze([
  ...Object.values(VISIT_PACK_COPY),
  SENSITIVE_SHARING_WARNING,
  VISIT_PACK_REVIEW_LIMITATION,
  ...Object.values(VISIT_PACK_SECTION_DESCRIPTIONS).flatMap((d) => [d.label, d.meaning]),
]);
