/**
 * Presentation for the Household Review Inbox.
 *
 * Spec references: `04` Phase 8.3, `03` group G (the alert experience this must not resemble),
 * `18` (plain language, no shaming, one idea per sentence, limitations stated), `02` (a calm
 * product that does not optimise for alarm).
 *
 * EXIT CRITERION 1, AS A RENDERING RULE
 * "Review tasks are clearly different from safety alerts" is where a well-built backend usually
 * loses: the domain keeps the two apart, and then a screen renders both as cards with a coloured
 * left border and they become indistinguishable at a glance. So the tones this module may use are
 * a *closed subset* - {@link REVIEW_TASK_TONES} - which deliberately excludes `action` and
 * `attention`, the two tones `presentUrgency` gives to CRITICAL, HIGH and MEDIUM. A review task
 * cannot be rendered in the colours of an alert, and a test asserts the exclusion rather than
 * trusting each call site.
 *
 * The copy carries the same rule in words. Every task says what it is *for*, and none of them
 * says or implies that anything is wrong: a missing batch number is not a hazard, it is a gap in
 * what Kynviora would be able to check.
 */

import type { ReviewTaskKind } from '@kynviora/domain';
import { REVIEW_TASK_KINDS } from '@kynviora/domain';
import type { ThemeToneToken } from './tokens.js';

// ---------------------------------------------------------------------------
// Tone
// ---------------------------------------------------------------------------

/**
 * The only tones a review task may use.
 *
 * `action` and `attention` are absent by design: those are the tones an alert uses for CRITICAL,
 * HIGH and MEDIUM urgency, and borrowing one would make maintenance work read as a warning. The
 * absence is the mechanism, not a convention - the type below cannot express the others.
 */
export const REVIEW_TASK_TONES = ['neutral', 'informational'] as const;
export type ReviewTaskTone = (typeof REVIEW_TASK_TONES)[number];

/** Compile-time proof that every review tone is a real theme tone. */
const _toneCheck: readonly ThemeToneToken[] = REVIEW_TASK_TONES;
void _toneCheck;

// ---------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------

export interface ReviewTaskDescription {
  /** Short visible text. Describes the work, never a hazard. */
  readonly label: string;
  /** What doing it achieves, in plain language. */
  readonly meaning: string;
  /** The label on the control that completes it. */
  readonly actionLabel: string;
  readonly tone: ReviewTaskTone;
}

export const REVIEW_TASK_DESCRIPTIONS: Readonly<Record<ReviewTaskKind, ReviewTaskDescription>> =
  Object.freeze({
    ITEM_NOT_REVIEWED_RECENTLY: {
      label: 'Check these details are still right',
      meaning:
        'It has been a while since this was looked at. A quick check keeps the rest of Kynviora accurate.',
      actionLabel: 'Confirm details',
      tone: 'neutral',
    },
    BATCH_MISSING: {
      label: 'Add the batch number',
      meaning:
        'With a batch number Kynviora can tell you whether a recall applies to your pack, not just to the product.',
      actionLabel: 'Add batch number',
      tone: 'informational',
    },
    FORMULA_NEEDS_CONFIRMATION: {
      label: 'Confirm the ingredients',
      meaning: 'Sources disagree about what is in this one. Your pack settles it.',
      actionLabel: 'Confirm ingredients',
      tone: 'informational',
    },
    OCR_FIELD_UNRESOLVED: {
      label: 'Check what was read from the pack',
      meaning:
        'Kynviora read this from a photo and has not had it confirmed. Your eyes are better.',
      actionLabel: 'Confirm or correct',
      tone: 'informational',
    },
    CAREGIVER_GRANT_EXPIRING: {
      label: 'Caregiver access is ending soon',
      meaning: 'You can extend it, or let it end. Nothing changes until you choose.',
      actionLabel: 'Review access',
      tone: 'informational',
    },
    SAFETY_ITEM_AWAITING_CONFIRMATION: {
      label: 'Tell Kynviora what you did',
      meaning:
        'You looked at a safety item but have not recorded the outcome. Recording it keeps the history complete.',
      actionLabel: 'Record outcome',
      tone: 'neutral',
    },
    REFILL_ESTIMATE_NEEDS_REVIEW: {
      label: 'Update the refill estimate',
      meaning:
        'This estimate was worked out from older numbers, so the date it gives is probably wrong.',
      actionLabel: 'Update estimate',
      tone: 'neutral',
    },
  });

export function describeReviewTask(kind: ReviewTaskKind): ReviewTaskDescription {
  return REVIEW_TASK_DESCRIPTIONS[kind];
}

// ---------------------------------------------------------------------------
// The inbox as a whole
// ---------------------------------------------------------------------------

export interface InboxLine {
  readonly taskId: string;
  readonly kind: ReviewTaskKind;
  readonly label: string;
  readonly meaning: string;
  readonly actionLabel: string;
  readonly tone: ReviewTaskTone;
  readonly subjectLabel: string | null;
}

export interface InboxSummary {
  readonly lines: readonly InboxLine[];
  readonly total: number;
  /** Shown when there is nothing to do. Never congratulatory - it is just a fact. */
  readonly emptyMessage: string | null;
  readonly limitation: string;
}

/**
 * `18`: the limitation is stated rather than implied.
 *
 * The specific misreading this heads off is "the inbox is empty, so everything is fine". An empty
 * inbox means Kynviora has no maintenance work to suggest, which is a much smaller claim, and
 * `09`'s coverage rule applies here for the same reason it applies to a safety result.
 */
export const INBOX_LIMITATION =
  'This list is about keeping your records accurate. It is not a safety check.';

export const INBOX_EMPTY = 'Nothing needs your attention here right now.';

/**
 * Build the whole inbox view.
 *
 * Deliberately takes no urgency, no ordering hint and no count of anything "important". The
 * ordering is whatever the caller supplies - oldest first from the API - because ranking
 * maintenance work by implied severity is how the inbox would start to look like an alert list.
 */
export function summarizeInbox(
  tasks: readonly {
    readonly taskId: string;
    readonly kind: ReviewTaskKind;
    readonly subjectLabel: string | null;
  }[],
): InboxSummary {
  const lines = tasks.map((task) => {
    const description = REVIEW_TASK_DESCRIPTIONS[task.kind];
    return {
      taskId: task.taskId,
      kind: task.kind,
      label: description.label,
      meaning: description.meaning,
      actionLabel: description.actionLabel,
      tone: description.tone,
      subjectLabel: task.subjectLabel,
    };
  });

  return {
    lines,
    total: lines.length,
    emptyMessage: lines.length === 0 ? INBOX_EMPTY : null,
    limitation: INBOX_LIMITATION,
  };
}

// ---------------------------------------------------------------------------
// Completion copy
// ---------------------------------------------------------------------------

export const REVIEW_INBOX_COPY = Object.freeze({
  heading: 'Things to check',
  intro: 'None of this is urgent. Each one makes what Kynviora can tell you a little more exact.',
  // The user-facing statement of exit criterion 2. Saying it is not decoration: someone who
  // expects a tick box needs to know why the screen is asking for something.
  completionRequiresChange:
    'Completing one of these updates your records. Kynviora does not keep a separate tick list.',
  notApplicableLabel: 'This does not apply',
  notApplicableMeaning: 'Kynviora will record that you checked, and stop asking.',
  dismissedNote: 'Recorded as checked.',
});

/**
 * The per-task strings only.
 *
 * Separate from {@link ALL_REVIEW_INBOX_STRINGS} because the framing copy legitimately uses the
 * words a task description must not: the intro says "none of this is urgent", which is the
 * opposite of describing a task as urgent. Scanning both lists with the same rule would force the
 * intro to stop saying the one thing it exists to say.
 */
export const ALL_REVIEW_TASK_STRINGS: readonly string[] = Object.freeze(
  Object.values(REVIEW_TASK_DESCRIPTIONS).flatMap((d) => [d.label, d.meaning, d.actionLabel]),
);

/** Every fixed string here, for the forbidden-claim test. */
export const ALL_REVIEW_INBOX_STRINGS: readonly string[] = Object.freeze([
  ...Object.values(REVIEW_INBOX_COPY),
  ...Object.values(REVIEW_TASK_DESCRIPTIONS).flatMap((d) => [d.label, d.meaning, d.actionLabel]),
  INBOX_LIMITATION,
  INBOX_EMPTY,
]);

/** Every kind has a description. Guards against a kind added without user-facing words. */
export function everyReviewKindDescribed(): boolean {
  return REVIEW_TASK_KINDS.every((kind) => REVIEW_TASK_DESCRIPTIONS[kind] !== undefined);
}
