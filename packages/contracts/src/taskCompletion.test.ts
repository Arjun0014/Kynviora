import { describe, it, expect } from 'vitest';
import {
  NOTHING_CHANGED_MESSAGE,
  buildCompletion,
  canComplete,
  type FormValues,
} from './taskCompletion.js';
import { COMPLETABLE_FIELDS, REVIEW_TASK_KINDS, SUBJECT_FOR_KIND } from '@kynviora/domain';
import { taskForm } from '@kynviora/presentation';

const NOW = '2026-09-01T12:00:00.000Z';
const SUBJECT = '00000000-0000-4000-8000-00000000d030';

const forKind = (kind: (typeof REVIEW_TASK_KINDS)[number]) => ({ kind, subjectId: SUBJECT });

/** The kinds this editor can complete. The rest need guided capture (`DEV-024`). */
const COMPLETABLE_KINDS = REVIEW_TASK_KINDS.filter((kind) => taskForm(kind).completableHere);

/** The first field of a kind that a person can actually supply. */
const firstField = (kind: (typeof REVIEW_TASK_KINDS)[number]): string =>
  taskForm(kind).fields[0]!.field;

describe('a task that needs guided capture cannot be completed here at all', () => {
  it('refuses before looking at any value', () => {
    // BATCH_MISSING also permits writing `batch_verification`. If the builder considered values
    // first, someone could record "I am not sure" and close a task called "add the batch
    // number" - a mark-done path wearing a different label (trap 16).
    for (const kind of ['BATCH_MISSING', 'FORMULA_NEEDS_CONFIRMATION'] as const) {
      for (const values of [{}, { batch_verification: 'CONFIRMED' }, { batch_id: 'LOT-1' }]) {
        const result = buildCompletion(forKind(kind), values, NOW);
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.refusal.reason).toBe('NEEDS_CAPTURE');
      }
    }
  });

  it('says what is needed rather than reporting an error', () => {
    const result = buildCompletion(forKind('BATCH_MISSING'), {}, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.message).toMatch(/not ready yet/i);
  });
});

describe('a completion always writes something', () => {
  it('refuses an empty form and names the field to start with', () => {
    // DEC-027 and trap 16: there is no mark-done path. A form that could be submitted empty
    // would produce a server error about a request the user did not knowingly make.
    const result = buildCompletion(forKind('OCR_FIELD_UNRESOLVED'), {}, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.reason).toBe('REQUIRED_FIELD_MISSING');
    // `12`: say what the user can do next.
    expect(result.refusal.message.toLowerCase()).toContain('product name');
  });

  it('refuses a form whose every field was opened and left blank', () => {
    // Whitespace is not a change. Sending an empty string would write one, which is a different
    // statement from "I did not fill this in".
    const result = buildCompletion(forKind('OCR_FIELD_UNRESOLVED'), { display_name: '   ' }, NOW);
    expect(result.ok).toBe(false);
  });

  it('never produces a completion with no changes, for any kind', () => {
    // The property the server enforces, enforced again here so the button can be disabled rather
    // than the request refused.
    for (const kind of REVIEW_TASK_KINDS) {
      expect(buildCompletion(forKind(kind), {}, NOW).ok).toBe(false);
    }
  });

  it('says why, in words a user can act on', () => {
    expect(NOTHING_CHANGED_MESSAGE).toMatch(/updates the record it is about/i);
    expect(NOTHING_CHANGED_MESSAGE.toLowerCase()).not.toMatch(/invalid|error|failed/);
  });
});

describe('what it sends', () => {
  it('targets the task’s own subject record, with the kind the domain expects', () => {
    // `evaluateCompletion` refuses a change that names a different record. Getting the record
    // kind from `SUBJECT_FOR_KIND` rather than guessing is what keeps the two in step.
    for (const kind of COMPLETABLE_KINDS) {
      const result = buildCompletion(forKind(kind), { [firstField(kind)]: '42' }, NOW);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      for (const change of result.completion.changes) {
        expect(change.recordKind).toBe(SUBJECT_FOR_KIND[kind]);
        expect(change.recordId).toBe(SUBJECT);
      }
    }
  });

  it('sends only fields the task is about', () => {
    // A value for a field this kind cannot write would be refused by the server with a message
    // about a field the user never saw.
    const result = buildCompletion(
      forKind('OCR_FIELD_UNRESOLVED'),
      { display_name: 'Synthetic Tablet A', quantity_remaining: '10' },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.reason).toBe('FIELD_NOT_PART_OF_TASK');
  });

  it('resolves a confirmation field to the supplied instant, not to ambient time', () => {
    // DEC-003: ambient time here would make a completion irreproducible the same way it makes an
    // assessment irreproducible.
    const result = buildCompletion(
      forKind('ITEM_NOT_REVIEWED_RECENTLY'),
      { last_reviewed_at: '' },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.completion.changes).toEqual([
      { recordKind: 'owned_item', recordId: SUBJECT, field: 'last_reviewed_at', value: NOW },
    ]);
  });

  it('treats an explicit null as a change, not as an omission', () => {
    // "There is nothing printed here" is information, and it is not the same as not having
    // looked.
    const result = buildCompletion(forKind('OCR_FIELD_UNRESOLVED'), { strength_text: null }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.completion.changes[0]?.value).toBeNull();
  });

  it('trims what the user typed', () => {
    const result = buildCompletion(
      forKind('OCR_FIELD_UNRESOLVED'),
      { display_name: '  Synthetic Tablet A  ' },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.completion.changes[0]?.value).toBe('Synthetic Tablet A');
  });
});

describe('fields that are alternatives rather than a set', () => {
  it('accepts any one of the label fields for an unresolved extraction', () => {
    // Correcting the strength alone completes the task. A rule that required the primary field
    // would refuse completions the server accepts.
    for (const field of COMPLETABLE_FIELDS.OCR_FIELD_UNRESOLVED) {
      const result = buildCompletion(forKind('OCR_FIELD_UNRESOLVED'), { [field]: 'x' }, NOW);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.completion.changes.map((c) => c.field)).toEqual([field]);
    }
  });

  it('sends every field the user did fill in', () => {
    const result = buildCompletion(
      forKind('REFILL_ESTIMATE_NEEDS_REVIEW'),
      { quantity_remaining: '20', doses_per_day: '2' },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.completion.changes.map((c) => c.field).sort()).toEqual([
      'doses_per_day',
      'quantity_remaining',
    ]);
  });
});

describe('the outcome', () => {
  it('is always RESOLVED', () => {
    // The API accepts NOT_APPLICABLE and the domain requires it to write too. The editor does not
    // offer it, because what it should write differs per kind and most kinds have no field that
    // expresses it (DEV-023). Where the vocabulary already has the word - a safety receipt - it
    // is a value on the `resolution` field, which is where it belongs.
    for (const kind of COMPLETABLE_KINDS) {
      const result = buildCompletion(forKind(kind), { [firstField(kind)]: 'x' }, NOW);
      if (!result.ok) continue;
      expect(result.completion.outcome).toBe('RESOLVED');
    }
  });

  it('offers "not applicable" as a safety-receipt resolution value', () => {
    const result = buildCompletion(
      forKind('SAFETY_ITEM_AWAITING_CONFIRMATION'),
      { resolution: 'NOT_APPLICABLE' },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.completion.changes[0]).toEqual({
      recordKind: 'alert_publication',
      recordId: SUBJECT,
      field: 'resolution',
      value: 'NOT_APPLICABLE',
    });
  });
});

describe('the button and the builder agree', () => {
  it('says yes exactly when a completion can be built', () => {
    // The same code path, so a button cannot enable something the builder would refuse.
    const cases: FormValues[] = [
      {},
      { display_name: '' },
      { display_name: 'Synthetic Tablet A' },
      { strength_text: '500 mg' },
    ];
    for (const values of cases) {
      expect(canComplete(forKind('OCR_FIELD_UNRESOLVED'), values, NOW)).toBe(
        buildCompletion(forKind('OCR_FIELD_UNRESOLVED'), values, NOW).ok,
      );
    }
    // And it stays false for a kind no set of values can complete.
    expect(canComplete(forKind('BATCH_MISSING'), { batch_id: 'x' }, NOW)).toBe(false);
  });
});
