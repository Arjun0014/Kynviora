/**
 * Recording a dose event, and the history a person reads back.
 *
 * Spec references: `04` Phase 4.3 ("record what happened without gamifying or judging them";
 * "duplicate sync does not create duplicate dose events"), `13` (idempotency key on retryable
 * mutations; conflict policy `dose_event: MERGE_BY_ID`), `02` (gamified adherence scoring is a
 * named anti-feature), `23` D-005.
 *
 * WHY THE HISTORY IS A LIST AND NOT A SUMMARY
 * There is no `takenCount`, no `adherenceRate`, no streak and no "you have skipped this three
 * times". Phase 4.3's goal is a record, not a report card. Someone who skipped a dose because it
 * made them ill has recorded a decision about their own treatment, and a number telling them how
 * often they do it has told them the decision was wrong - which is medical advice, arrived at by
 * arithmetic and attributed to nobody.
 *
 * The absence is asserted by tests over this module's own exports and over the view's keys,
 * because a count is the single easiest thing to add here and the hardest to notice afterwards.
 *
 * THE IDEMPOTENCY KEY IS A PARAMETER
 * `13` requires the server to commit exactly once, and Phase 4.3 makes it an exit criterion: an
 * event created offline may be uploaded more than once. A key generated inside a retry is not an
 * idempotency key, it is a second dose event - and a duplicated history is a false record of what
 * somebody did.
 */

import { isDoseEventKind, type DoseEventKind } from '@kynviora/domain';
import {
  DOSE_COPY,
  DOSE_EVENT_ORDER,
  describeDoseEvent,
  presentDoseEvent,
  recordedOn,
  type StatusPresentation,
} from '@kynviora/presentation';
import type { DoseEventRecord } from './client.js';

/** The longest note the server accepts. Mirrored so a screen can say so before a 400. */
export const MAX_DOSE_NOTE_LENGTH = 500;

export type DoseRecordRefusal =
  | { readonly reason: 'NOT_A_MEDICINE'; readonly message: string }
  | { readonly reason: 'NOTE_TOO_LONG'; readonly message: string };

export const NOT_A_MEDICINE_MESSAGE =
  'Doses are recorded for medicines. This is a personal-care product.';

export const NOTE_TOO_LONG_MESSAGE = `Keep the note under ${MAX_DOSE_NOTE_LENGTH} characters.`;

export interface DoseRecordDraft {
  readonly ok: boolean;
  readonly refusal: DoseRecordRefusal | null;
  /** The body to send, or `null`. Never carries anything the server would refuse. */
  readonly body: {
    readonly ownedItemId: string;
    readonly eventKind: DoseEventKind;
    readonly scheduledFor?: string;
    readonly scheduleId?: string;
    readonly note?: string;
  } | null;
}

/**
 * Build the request, or say why it cannot be built.
 *
 * The note is passed through exactly as it was typed. Nothing here trims it to a summary,
 * sentence-cases it or strips a word: it is the person's own account of what happened to them,
 * and `04` Phase 4.1's rule about not rewriting an instruction is the same rule one step over.
 * Leading and trailing whitespace is dropped only to decide whether a note was written at all.
 */
export function buildDoseRecord(input: {
  readonly ownedItemId: string;
  readonly itemKind: string;
  readonly eventKind: DoseEventKind;
  readonly scheduledFor?: string | null;
  readonly scheduleId?: string | null;
  readonly note?: string | null;
}): DoseRecordDraft {
  if (input.itemKind !== 'MEDICINE') {
    // Not a security decision - the server would accept it, because `dose_event` references an
    // owned item of either kind. It is a product one: a dose is a medicine's idea, and offering
    // the control on a shampoo would record something nobody can read back meaningfully.
    return {
      ok: false,
      refusal: { reason: 'NOT_A_MEDICINE', message: NOT_A_MEDICINE_MESSAGE },
      body: null,
    };
  }

  const note = input.note ?? '';
  if (note.trim().length > 0 && note.length > MAX_DOSE_NOTE_LENGTH) {
    return {
      ok: false,
      refusal: { reason: 'NOTE_TOO_LONG', message: NOTE_TOO_LONG_MESSAGE },
      body: null,
    };
  }

  return {
    ok: true,
    refusal: null,
    body: {
      ownedItemId: input.ownedItemId,
      eventKind: input.eventKind,
      ...(input.scheduledFor === null || input.scheduledFor === undefined
        ? {}
        : { scheduledFor: input.scheduledFor }),
      ...(input.scheduleId === null || input.scheduleId === undefined
        ? {}
        : { scheduleId: input.scheduleId }),
      ...(note.trim().length === 0 ? {} : { note }),
    },
  };
}

/**
 * Narrow a recorded kind, or refuse it.
 *
 * `null` rather than a fallback, for the same reason a review task kind has none: the
 * presentation layer holds one description per kind and no default, so an event this build cannot
 * name has no words anyone wrote. Guessing would put a sentence about somebody's medicine next to
 * a date that makes it look recorded by them.
 */
export function asDoseEventKind(raw: string): DoseEventKind | null {
  return isDoseEventKind(raw) ? raw : null;
}

export interface DoseHistoryLineView {
  readonly id: string;
  readonly presentation: StatusPresentation;
  /** The date it was recorded. Not a time to the second - see `recordedOn`. */
  readonly recordedOn: string;
  /**
   * The dose it was recorded against, where there was one.
   *
   * Kept separate from `recordedOn` because they are different facts: a dose due on Tuesday can be
   * recorded on Wednesday, and merging them would misdate one of the two.
   */
  readonly scheduledOn: string | null;
  /** The person's own words, verbatim, or `null`. */
  readonly note: string | null;
}

export interface DoseHistoryView {
  readonly lines: readonly DoseHistoryLineView[];
  /**
   * Events dropped because this build has no words for the kind.
   *
   * Counted rather than hidden. This is the one number on the screen, and it counts what could
   * not be shown - not what was done.
   */
  readonly unreadableCount: number;
  /** The words for an empty history. Not "well done" and not "nothing to report". */
  readonly emptyMessage: string;
}

/**
 * The history a person reads, in the order the route returned it.
 *
 * Newest first is the route's decision, not re-sorted here: two screens disagreeing about what
 * happened most recently is worse than either order.
 */
export function doseHistory(events: readonly DoseEventRecord[]): DoseHistoryView {
  const lines: DoseHistoryLineView[] = [];
  let unreadableCount = 0;

  for (const event of events) {
    const kind = asDoseEventKind(event.eventKind);
    if (kind === null) {
      unreadableCount += 1;
      continue;
    }
    lines.push({
      id: event.id,
      presentation: presentDoseEvent(kind),
      recordedOn: recordedOn(event.recordedAt),
      scheduledOn: event.scheduledFor === null ? null : recordedOn(event.scheduledFor),
      note: event.note,
    });
  }

  return { lines, unreadableCount, emptyMessage: DOSE_COPY.historyEmpty };
}

/**
 * The controls a person is offered, in the vocabulary's own order.
 *
 * Derived from `DOSE_EVENT_ORDER` rather than listed here, so a new kind appears as a control and
 * fails to compile in the presentation layer until somebody writes the words for it. A hand-kept
 * list is how a kind reaches the database and never reaches a screen.
 */
export function doseActions(): readonly {
  readonly kind: DoseEventKind;
  readonly label: string;
  readonly accessibilityLabel: string;
}[] {
  return DOSE_EVENT_ORDER.map((kind) => {
    const description = describeDoseEvent(kind);
    return {
      kind,
      label: description.actionLabel,
      accessibilityLabel: description.accessibilityLabel,
    };
  });
}
