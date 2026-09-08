/**
 * How a change is drawn, said, and read aloud.
 *
 * Spec references: `18` (never colour alone; one idea per sentence; announce in a logical order),
 * `02` (no score, no ranking), DEC-153.
 *
 * The arithmetic lives in `@kynviora/domain`'s `changeLens.ts` and is not repeated here. This
 * module answers the second half of the same question: given a classification, what word goes on
 * screen, what shape sits beside it, what colour supports it, and what a screen reader says.
 *
 * WHY `change` IS ITS OWN TONE TOKEN AND WHY IT IS WIDENED HERE RATHER THAN IN `status.ts`
 * `ThemeToneToken` is the codomain of a safety status. `change` is not in it, on purpose: a safety
 * status painted violet would be announcing a difference between two records where the screen had
 * asked what state a product is in. But a *change section* legitimately needs the colour, so the
 * union is widened in this file and nowhere else. The narrow type stays narrow where it matters.
 */

import type { ChangeClass, ChangeDirection, ChangeEntry } from '@kynviora/domain';
import { ownEntry } from '@kynviora/domain';
import type { IconName } from './status.js';
import type { ThemeToneToken } from './tokens.js';

/**
 * The tones a change may be drawn in.
 *
 * `ThemeToneToken` plus exactly one more. Written as a union rather than by adding `change` to
 * `THEME_TONE_TOKENS`, so the widening is visible at every call site that accepts it.
 */
export type ChangeToneToken = ThemeToneToken | 'change';

export interface ChangePresentation {
  /** Short visible text. Always rendered - it is the primary carrier of meaning. */
  readonly label: string;
  readonly iconName: IconName;
  readonly tone: ChangeToneToken;
  /** One sentence saying what the section contains. */
  readonly description: string;
  readonly accessibilityLabel: string;
  /**
   * Whether the section is collapsed by default.
   *
   * Only `SIMILAR` is. The design language says so and the reason is the one `18` cares about:
   * on a report of forty analytes, thirty-four of which did not move, an expanded Similar section
   * pushes the four that did below the fold - so the default hides what did not change rather
   * than what did. It is a default and not a removal; the section is present and countable.
   */
  readonly collapsedByDefault: boolean;
}

/**
 * One presentation per class.
 *
 * "Not repeated" rather than "Missing" or "Removed", deliberately. Kynviora does not know why a
 * test was not done again - the clinician may not have asked for it, the lab may not offer it,
 * the person may have declined - and every one of the shorter words asserts a reason.
 */
const BY_CLASS: Readonly<Record<ChangeClass, ChangePresentation>> = Object.freeze({
  CHANGED: Object.freeze({
    label: 'Changed',
    iconName: 'diff',
    tone: 'change',
    description: 'Measured in both records, and the value moved past the stated threshold.',
    accessibilityLabel: 'Changed. Measured in both records, and the value moved.',
    collapsedByDefault: false,
  }),
  NEW: Object.freeze({
    label: 'New',
    iconName: 'plus-circle',
    tone: 'change',
    description: 'Present in this record and not in the one it is compared with.',
    accessibilityLabel: 'New. Present in this record and not in the earlier one.',
    collapsedByDefault: false,
  }),
  NOT_REPEATED: Object.freeze({
    label: 'Not repeated',
    iconName: 'minus-circle',
    tone: 'neutral',
    description:
      'Present in the earlier record and not in this one. Kynviora does not know why, and an absence is not a result.',
    accessibilityLabel:
      'Not repeated. Present in the earlier record and not in this one. Kynviora does not know why.',
    collapsedByDefault: false,
  }),
  SIMILAR: Object.freeze({
    label: 'Similar',
    iconName: 'equals',
    tone: 'surfaceMuted',
    description: 'Measured in both records, and the value did not move past the stated threshold.',
    accessibilityLabel: 'Similar. Measured in both records, and the value did not move.',
    collapsedByDefault: true,
  }),
});

export function changeClassPresentation(classification: ChangeClass): ChangePresentation {
  // DEC-147: resolved as an own property, so a value that arrived from a row or a model and
  // happens to spell `constructor` cannot come back as a function.
  return ownEntry(BY_CLASS, classification) ?? BY_CLASS.SIMILAR;
}

/** Shapes for direction. Distinguishable in greyscale, and never the only carrier of it. */
const DIRECTION_GLYPH: Readonly<Record<ChangeDirection, string>> = Object.freeze({
  UP: '▲',
  DOWN: '▼',
  NONE: '–',
});

const DIRECTION_WORD: Readonly<Record<ChangeDirection, string>> = Object.freeze({
  UP: 'up',
  DOWN: 'down',
  NONE: 'unchanged',
});

export function directionGlyph(direction: ChangeDirection): string {
  return ownEntry(DIRECTION_GLYPH, direction) ?? DIRECTION_GLYPH.NONE;
}

export function directionWord(direction: ChangeDirection): string {
  return ownEntry(DIRECTION_WORD, direction) ?? DIRECTION_WORD.NONE;
}

/**
 * Round to at most `decimals` places without inventing precision.
 *
 * `toFixed` would pad: a delta of 0.4 rendered as "0.40" claims a hundredth the source never
 * reported. So the value is rounded and then printed by `String`, which drops trailing zeros.
 */
function trim(value: number, decimals: number): string {
  const factor = 10 ** Math.max(0, Math.min(decimals, 6));
  return String(Math.round(value * factor) / factor);
}

/**
 * Why a change carries no number, in words.
 *
 * Present so a screen can say what happened rather than showing an empty cell. A blank where a
 * delta belongs reads as "nothing moved", which is the one thing it does not mean.
 */
const INCOMPARABLE_SENTENCE = Object.freeze({
  UNIT_CHANGED: 'The unit changed, so the two values are not compared.',
  NOT_NUMERIC: 'The result is text rather than a number, so it is compared word for word.',
  PREVIOUS_ZERO: 'The earlier value was zero, so there is no proportional change to state.',
  ONE_SIDE_ONLY: 'Neither record carries a value for this.',
});

/**
 * How one row of a change list reads.
 *
 * `delta` and `relative` are formatted strings or `null`, never `NaN` and never `'-'`: a caller
 * rendering `null` chooses what an absence looks like, and a caller rendering `'-'` has had that
 * choice made for it by a formatter.
 */
export interface ChangeRowPresentation {
  readonly label: string;
  readonly classification: ChangeClass;
  readonly currentText: string | null;
  readonly previousText: string | null;
  readonly deltaText: string | null;
  readonly relativeText: string | null;
  readonly directionGlyph: string;
  readonly tone: ChangeToneToken;
  /** Why there is no delta, where there is none and one was expected. */
  readonly incomparableNote: string | null;
  readonly accessibilityLabel: string;
}

function valueText(value: ChangeEntry['current'], decimals: number): string | null {
  if (value === null) return null;
  if (value.value === null) return value.text ?? null;
  const unit = value.unit === undefined || value.unit === '' ? '' : ` ${value.unit}`;
  return `${trim(value.value, decimals)}${unit}`;
}

/**
 * Render one classified entry.
 *
 * `decimals` is how many places the *source* reported, passed in rather than guessed: a TSH of
 * 5.2 and a sodium of 141 are printed differently because the report printed them differently,
 * and rounding a lab value to a house default is a small lie about the measurement.
 */
export function changeRowPresentation(entry: ChangeEntry, decimals = 2): ChangeRowPresentation {
  const section = changeClassPresentation(entry.classification);
  const currentText = valueText(entry.current, decimals);
  const previousText = valueText(entry.previous, decimals);

  const deltaText =
    entry.delta === null
      ? null
      : `${entry.delta > 0 ? '+' : entry.delta < 0 ? '−' : ''}${trim(Math.abs(entry.delta), decimals)}`;
  const relativeText =
    entry.relative === null ? null : `${trim(Math.abs(entry.relative) * 100, 1)}%`;

  const incomparableNote =
    entry.incomparableReason === undefined
      ? null
      : (ownEntry(INCOMPARABLE_SENTENCE, entry.incomparableReason) ?? null);

  // Announced in the order `18` asks for: what it is, what it did, then the numbers - so a
  // screen reader user hears the conclusion before the arithmetic.
  const parts: string[] = [`${entry.label}. ${section.label}.`];
  if (entry.classification === 'NEW' && currentText !== null) {
    parts.push(`${currentText}, not measured in the earlier record.`);
  } else if (entry.classification === 'NOT_REPEATED' && previousText !== null) {
    parts.push(`Was ${previousText}. Not measured in this record.`);
  } else if (currentText !== null && previousText !== null) {
    parts.push(`${previousText} to ${currentText}.`);
    if (deltaText !== null) {
      parts.push(
        `${directionWord(entry.direction)} by ${trim(Math.abs(entry.delta ?? 0), decimals)}.`,
      );
    }
  }
  if (incomparableNote !== null) parts.push(incomparableNote);

  return {
    label: entry.label,
    classification: entry.classification,
    currentText,
    previousText,
    deltaText,
    relativeText,
    directionGlyph: directionGlyph(entry.direction),
    tone: section.tone,
    incomparableNote,
    accessibilityLabel: parts.join(' '),
  };
}

/**
 * The heading over a comparison: the counts, in the order the sections appear.
 *
 * A caller could compute this from `ChangeSummary.counts` in two lines, and that is exactly the
 * two lines that eventually differ between two screens. The sentence template lives here.
 */
export function changeCountSentence(
  counts: Readonly<Record<ChangeClass, number>>,
  comparedCount: number,
): string {
  const measured = `${comparedCount} ${comparedCount === 1 ? 'result' : 'results'} measured in both records`;
  const clauses: string[] = [];
  if (counts.CHANGED > 0) clauses.push(`${counts.CHANGED} changed`);
  if (counts.NEW > 0) clauses.push(`${counts.NEW} new`);
  if (counts.NOT_REPEATED > 0) clauses.push(`${counts.NOT_REPEATED} not repeated`);
  if (clauses.length === 0)
    return `${measured}. Nothing changed, and nothing was added or dropped.`;
  return `${measured}. ${clauses.join(', ')}.`;
}

/**
 * What the counts describe, said in the app's own voice.
 *
 * Printed beside any comparison. `02` forbids anything that reads as a verdict, and a row of
 * numbers under a health heading reads as one unless something says otherwise. This is that
 * something, and it is a constant rather than per-screen copy so no surface can soften it.
 */
export const CHANGE_COUNTS_DISCLAIMER =
  'These counts describe the difference between two records. They are not a judgement about health.';
