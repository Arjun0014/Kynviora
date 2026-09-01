import { describe, it, expect } from 'vitest';
import {
  ALL_TASK_EDITOR_STRINGS,
  COMPLETION_NOTE,
  FIELD_INPUTS,
  everyCompletableFieldEditable,
  taskForm,
} from './reviewTaskEditor.js';
import { findForbiddenClaims } from './copy.js';
import { COMPLETABLE_FIELDS, REVIEW_TASK_KINDS } from '@kynviora/domain';

describe('the form matches what the domain permits', () => {
  it('has a definition for every completable field and nothing spare', () => {
    // Both directions. A field this form offers that the domain would refuse is a control that
    // always errors; a field the domain permits that this form omits is a task nobody can
    // complete.
    expect(everyCompletableFieldEditable()).toBe(true);
  });

  it('builds a form for every completable kind, in the domain’s field order', () => {
    for (const kind of REVIEW_TASK_KINDS) {
      const form = taskForm(kind);
      if (!form.completableHere) continue;
      expect(form.fields.map((field) => field.field)).toEqual([...COMPLETABLE_FIELDS[kind]]);
      expect(form.fields.length).toBeGreaterThan(0);
    }
  });

  it('offers no fields at all for a task that needs guided capture', () => {
    // BATCH_MISSING also permits writing `batch_verification`. Offering it alone would let
    // someone record "I am not sure" and close a task called "add the batch number" - a
    // mark-done path wearing a different label (trap 16).
    for (const kind of ['BATCH_MISSING', 'FORMULA_NEEDS_CONFIRMATION'] as const) {
      const form = taskForm(kind);
      expect(form.completableHere).toBe(false);
      expect(form.fields).toEqual([]);
      expect(form.needsCapture).not.toBeNull();
    }
  });

  it('completes the kinds whose fields are things a person can state', () => {
    for (const kind of [
      'ITEM_NOT_REVIEWED_RECENTLY',
      'OCR_FIELD_UNRESOLVED',
      'CAREGIVER_GRANT_EXPIRING',
      'SAFETY_ITEM_AWAITING_CONFIRMATION',
      'REFILL_ESTIMATE_NEEDS_REVIEW',
    ] as const) {
      expect(taskForm(kind).completableHere).toBe(true);
    }
  });

  it('never offers a record reference as something to type', () => {
    // The server casts these to `uuid`. A text box here is a control that always fails, which is
    // how this was found.
    for (const kind of REVIEW_TASK_KINDS) {
      for (const field of taskForm(kind).fields) {
        expect(field.input).not.toBe('REFERENCE');
      }
    }
  });

  it('gives every field a label, a reason and a real input kind', () => {
    for (const kind of REVIEW_TASK_KINDS) {
      for (const field of taskForm(kind).fields) {
        // `18` requires the reason for a request to be stated rather than assumed.
        expect(field.label.trim().length).toBeGreaterThan(0);
        expect(field.help.trim().length).toBeGreaterThan(0);
        expect(FIELD_INPUTS).toContain(field.input);
      }
    }
  });

  it('gives every choice field choices, and no others', () => {
    for (const kind of REVIEW_TASK_KINDS) {
      for (const field of taskForm(kind).fields) {
        if (field.input === 'CHOICE') {
          expect(field.choices.length).toBeGreaterThan(1);
          for (const choice of field.choices) {
            expect(choice.label.trim().length).toBeGreaterThan(0);
          }
        } else {
          expect(field.choices).toEqual([]);
        }
      }
    }
  });

  it('names exactly one primary field per completable kind', () => {
    // The field the form leads with and points at when nothing has been entered. Exactly one,
    // because two would leave the empty-form message picking arbitrarily between them and none
    // would leave it saying only that something is missing.
    for (const kind of REVIEW_TASK_KINDS) {
      const form = taskForm(kind);
      if (!form.completableHere) continue;
      expect(form.fields.filter((field) => field.primary)).toHaveLength(1);
    }
  });

  it('states on every form that completing it writes to the record', () => {
    // Exit criterion 2, said to the user. Someone expecting a tick box needs to know why the
    // screen is asking for something instead.
    for (const kind of REVIEW_TASK_KINDS) {
      expect(taskForm(kind).completionNote).toBe(COMPLETION_NOTE);
    }
    expect(COMPLETION_NOTE).toMatch(/updates the record/i);
  });
});

describe('the safety resolution vocabulary', () => {
  const resolution = taskForm('SAFETY_ITEM_AWAITING_CONFIRMATION').fields.find(
    (field) => field.field === 'resolution',
  );

  it('offers exactly the values the database permits', () => {
    // `receipt_resolution_valid` in migration 0006. A choice the constraint refuses is a control
    // that always fails, and one the constraint permits but the screen omits is an outcome
    // nobody can record.
    expect(resolution?.choices.map((choice) => choice.value).sort()).toEqual(
      [
        'DISCUSSED_WITH_PROFESSIONAL',
        'ITEM_IDENTITY_CORRECTED',
        'NOT_APPLICABLE',
        'QUARANTINED',
        'REPORTED_INCORRECT_MATCH',
        'RETURNED_OR_DISPOSED',
        'REVIEWED',
      ].sort(),
    );
  });

  it('has no word for stopping a medicine', () => {
    // `09`: Kynviora never records that it told someone to stop a prescription medicine, because
    // it is never permitted to say so. The absence of the word is what enforces that here.
    for (const choice of resolution?.choices ?? []) {
      expect(choice.value).not.toMatch(/STOP|DISCONTINUE|CEASE|HALT/i);
      expect(choice.label.toLowerCase()).not.toMatch(/stop|discontinu|cease/);
    }
  });
});

describe('the words', () => {
  it('makes no forbidden claim', () => {
    for (const text of ALL_TASK_EDITOR_STRINGS) {
      expect(findForbiddenClaims(text)).toEqual([]);
    }
  });

  it('never blames the user for the state of their records', () => {
    // `18` forbids shaming, and a maintenance form is exactly where it creeps in: "you have not
    // entered", "missing information you should have provided".
    for (const text of ALL_TASK_EDITOR_STRINGS) {
      expect(text.toLowerCase()).not.toMatch(
        /you (failed|forgot|did not|didn't|should have|neglected)|out of date because you/,
      );
    }
  });

  it('never tells the user what to do about a medicine', () => {
    // The editor asks for facts about a record. `09` keeps clinical instruction out of Kynviora's
    // voice entirely, and a help sentence is a place it could arrive unnoticed.
    for (const text of ALL_TASK_EDITOR_STRINGS) {
      expect(text.toLowerCase()).not.toMatch(
        /you should take|stop taking|take (one|two|this) |increase the dose|reduce the dose/,
      );
    }
  });

  it('says plainly what a capture-dependent task needs, without apologising', () => {
    // `18`: be plain about what Kynviora cannot do rather than offering a control that fails.
    const needs = taskForm('BATCH_MISSING').needsCapture ?? '';
    expect(needs).toMatch(/not ready yet/i);
    expect(needs.toLowerCase()).not.toMatch(/sorry|unfortunately|error|failed/);
  });
});
