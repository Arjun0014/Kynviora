/**
 * Turning a filled-in form into a completion request.
 *
 * Spec references: `04` Phase 8.3 (completing a task updates the relevant authoritative record),
 * DEC-027, trap 16, `12` (say what the user can do next), `13` (the client sends what the contract
 * says and nothing else).
 *
 * WHY THE "WRITES SOMETHING" RULE IS ENFORCED TWICE
 * The domain refuses a completion with an empty change set, and that is where the rule lives - a
 * client cannot be the guarantee, because a client can be replaced. This module enforces it again
 * anyway, for a different reason: a form that can be submitted into a guaranteed refusal produces
 * an error message about a request the user did not knowingly make. Checking here turns "something
 * went wrong" into a disabled button and a sentence saying which field is still needed.
 *
 * The two checks are not redundant because they answer different questions. The server's answers
 * "may this task close?" and the client's answers "is this form finished?".
 */

import { COMPLETABLE_FIELDS, SUBJECT_FOR_KIND, type ReviewTaskKind } from '@kynviora/domain';
import { taskForm, type EditableField } from '@kynviora/presentation';
import type { ReviewTaskCompletion } from './client.js';

/**
 * What the user typed, keyed by field name.
 *
 * A field the user left alone is absent. An explicitly cleared field is `null`, which is a change:
 * "this pack has no batch number printed on it" is information, and it is not the same as not
 * having looked.
 */
export type FormValues = Readonly<Record<string, string | null | undefined>>;

export type CompletionRefusal =
  | { readonly reason: 'NOTHING_CHANGED'; readonly message: string }
  /** The task names a record only guided capture can produce - a batch, a formulation. */
  | { readonly reason: 'NEEDS_CAPTURE'; readonly message: string }
  | {
      readonly reason: 'REQUIRED_FIELD_MISSING';
      readonly field: string;
      readonly label: string;
      readonly message: string;
    }
  | {
      readonly reason: 'FIELD_NOT_PART_OF_TASK';
      readonly field: string;
      readonly message: string;
    };

export type CompletionResult =
  | { readonly ok: true; readonly completion: ReviewTaskCompletion }
  | { readonly ok: false; readonly refusal: CompletionRefusal };

export const NOTHING_CHANGED_MESSAGE =
  'Add at least one detail. Completing this updates the record it is about, so there has to be ' +
  'something to record.';

/** Names the field the form leads with, so an empty form says what to do next (`12`). */
export function requiredFieldMessage(label: string): string {
  return `Start with ${label.toLowerCase()}, or fill in any of the details below.`;
}

/**
 * Build the completion payload, or say why it cannot be built.
 *
 * `now` is passed in rather than read: a `TIMESTAMP_NOW` field writes the moment the user
 * confirmed, and ambient time in this path would make a completion irreproducible in the same way
 * it makes an assessment irreproducible (DEC-003).
 */
export function buildCompletion(
  task: { readonly kind: ReviewTaskKind; readonly subjectId: string },
  values: FormValues,
  now: string,
): CompletionResult {
  const form = taskForm(task.kind);
  const permitted = COMPLETABLE_FIELDS[task.kind];

  // Refused before anything else, so no combination of values can produce a write that closes a
  // task without doing the thing the task is about (`DEV-024`).
  if (!form.completableHere) {
    return { ok: false, refusal: { reason: 'NEEDS_CAPTURE', message: form.needsCapture ?? '' } };
  }

  // A value for a field this kind cannot write is a bug in the calling screen, and sending it
  // would be refused by the server with a message about a field the user never saw.
  for (const field of Object.keys(values)) {
    if (values[field] === undefined) continue;
    if (!permitted.includes(field)) {
      return {
        ok: false,
        refusal: {
          reason: 'FIELD_NOT_PART_OF_TASK',
          field,
          message: `"${field}" is not part of this task.`,
        },
      };
    }
  }

  const changes: {
    recordKind: string;
    recordId: string;
    field: string;
    value: string | null;
  }[] = [];

  for (const definition of form.fields) {
    const supplied = valueFor(definition, values, now);
    if (supplied === undefined) {
      if (definition.primary && nothingSuppliedAtAll(form.fields, values, now)) {
        // The form is empty. Name the field it leads with, so the message says what to do rather
        // than only that something is missing.
        return {
          ok: false,
          refusal: {
            reason: 'REQUIRED_FIELD_MISSING',
            field: definition.field,
            label: definition.label,
            message: requiredFieldMessage(definition.label),
          },
        };
      }
      continue;
    }

    changes.push({
      recordKind: SUBJECT_FOR_KIND[task.kind],
      recordId: task.subjectId,
      field: definition.field,
      value: supplied,
    });
  }

  if (changes.length === 0) {
    return {
      ok: false,
      refusal: { reason: 'NOTHING_CHANGED', message: NOTHING_CHANGED_MESSAGE },
    };
  }

  return {
    ok: true,
    // Always RESOLVED. `NOT_APPLICABLE` is a real outcome the API accepts, and the editor does not
    // offer it because what it should write differs per kind and most kinds have no field that
    // expresses it (`DEV-023`). Where the vocabulary already has the word - a safety receipt - it
    // is offered as a value on the `resolution` field, which is where it belongs.
    completion: { outcome: 'RESOLVED', changes },
  };
}

/**
 * Read one field's value, resolving the inputs that do not come from a keyboard.
 *
 * `TIMESTAMP_NOW` is a confirmation rather than an entry: the user pressing "these details are
 * right" is what produces the value, so the form records the field as present and this supplies
 * the instant.
 */
function valueFor(
  definition: EditableField,
  values: FormValues,
  now: string,
): string | null | undefined {
  const raw = values[definition.field];
  if (raw === undefined) return undefined;
  if (definition.input === 'TIMESTAMP_NOW') return now;
  if (raw === null) return null;

  const trimmed = raw.trim();
  // A field the user opened and left blank is not a change. Sending an empty string would write
  // one, which is a different statement from "I did not fill this in".
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Whether the user has supplied nothing at all.
 *
 * A kind's fields are alternatives as often as they are a set - `OCR_FIELD_UNRESOLVED` offers four
 * label fields and correcting any one of them completes the task. So no individual field blocks
 * submission; the rule the user has to satisfy is "record something", and the primary field's
 * name is how the message stays useful when they have recorded nothing.
 */
function nothingSuppliedAtAll(
  fields: readonly EditableField[],
  values: FormValues,
  now: string,
): boolean {
  return fields.every((field) => valueFor(field, values, now) === undefined);
}

/**
 * Whether the form as it stands could be submitted.
 *
 * For enabling a button. Deliberately the same code path as {@link buildCompletion}, so the button
 * cannot say yes to something the builder would refuse.
 */
export function canComplete(
  task: { readonly kind: ReviewTaskKind; readonly subjectId: string },
  values: FormValues,
  now: string,
): boolean {
  return buildCompletion(task, values, now).ok;
}
