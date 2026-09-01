import { describe, it, expect } from 'vitest';
import * as doseEvents from './doseEvents.js';
import {
  MAX_DOSE_NOTE_LENGTH,
  NOTE_TOO_LONG_MESSAGE,
  NOT_A_MEDICINE_MESSAGE,
  asDoseEventKind,
  buildDoseRecord,
  doseActions,
  doseHistory,
} from './doseEvents.js';
import type { DoseEventRecord } from './client.js';
import { DOSE_EVENT_KINDS } from '@kynviora/domain';
import { DOSE_COPY } from '@kynviora/presentation';

const ITEM = '00000000-0000-4000-8000-00000000d030';

const record = (over: Partial<DoseEventRecord> = {}): DoseEventRecord => ({
  id: 'e1',
  ownedItemId: ITEM,
  scheduleId: null,
  eventKind: 'TAKEN',
  scheduledFor: null,
  recordedAt: '2026-09-01T09:15:00.000Z',
  note: null,
  ...over,
});

describe('recording what happened', () => {
  it('sends the kind and nothing the person did not supply', () => {
    const draft = buildDoseRecord({ ownedItemId: ITEM, itemKind: 'MEDICINE', eventKind: 'TAKEN' });
    expect(draft.ok).toBe(true);
    expect(draft.body).toEqual({ ownedItemId: ITEM, eventKind: 'TAKEN' });
  });

  it('carries the note exactly as it was typed', () => {
    // The person's own account of what happened to them. `04` Phase 4.1's rule about not
    // rewriting an instruction is the same rule one step over: nothing here trims it to a
    // summary, sentence-cases it, or strips a word.
    const note = '  felt sick after breakfast, waited an hour  ';
    const draft = buildDoseRecord({
      ownedItemId: ITEM,
      itemKind: 'MEDICINE',
      eventKind: 'SKIPPED',
      note,
    });
    expect(draft.body?.note).toBe(note);
  });

  it('omits a note that is only whitespace', () => {
    // An empty note and no note are the same fact, and storing one blank string as though it
    // were a remark makes the history read as if something was said.
    for (const note of ['', '   ', '\n']) {
      const draft = buildDoseRecord({
        ownedItemId: ITEM,
        itemKind: 'MEDICINE',
        eventKind: 'TAKEN',
        note,
      });
      expect(draft.body).not.toHaveProperty('note');
    }
  });

  it('refuses a note longer than the server will take', () => {
    const draft = buildDoseRecord({
      ownedItemId: ITEM,
      itemKind: 'MEDICINE',
      eventKind: 'TAKEN',
      note: 'x'.repeat(MAX_DOSE_NOTE_LENGTH + 1),
    });
    expect(draft.ok).toBe(false);
    expect(draft.refusal?.message).toBe(NOTE_TOO_LONG_MESSAGE);
    expect(draft.body).toBeNull();
  });

  it('refuses a personal-care product', () => {
    // Not a security decision - `dose_event` references an owned item of either kind and the
    // server would accept it. A dose is a medicine's idea, and a recorded dose of shampoo is a
    // row nobody can read back meaningfully.
    const draft = buildDoseRecord({
      ownedItemId: ITEM,
      itemKind: 'PERSONAL_CARE',
      eventKind: 'TAKEN',
    });
    expect(draft.ok).toBe(false);
    expect(draft.refusal?.message).toBe(NOT_A_MEDICINE_MESSAGE);
  });

  it('passes a schedule and its due time through where there is one', () => {
    const draft = buildDoseRecord({
      ownedItemId: ITEM,
      itemKind: 'MEDICINE',
      eventKind: 'TAKEN',
      scheduleId: 'sched-1',
      scheduledFor: '2026-09-01T08:00:00.000Z',
    });
    expect(draft.body?.scheduleId).toBe('sched-1');
    expect(draft.body?.scheduledFor).toBe('2026-09-01T08:00:00.000Z');
  });

  it('offers a control for every kind the vocabulary has', () => {
    // Derived from the vocabulary rather than hand-kept, so a new kind cannot reach the database
    // and never reach a screen.
    expect(doseActions().map((action) => action.kind)).toEqual([...DOSE_EVENT_KINDS]);
    for (const action of doseActions()) {
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.accessibilityLabel.length).toBeGreaterThan(0);
    }
  });
});

describe('the history a person reads back', () => {
  it('shows what was recorded, in the order the route returned it', () => {
    // Newest first is the route's decision. Re-sorting here would make two screens disagree about
    // what happened most recently.
    const view = doseHistory([
      record({ id: 'e1', eventKind: 'SKIPPED' }),
      record({ id: 'e2', eventKind: 'TAKEN' }),
    ]);
    expect(view.lines.map((line) => line.id)).toEqual(['e1', 'e2']);
    expect(view.lines[0]?.presentation.label).toBe('Skipped');
  });

  it('carries no count, rate, streak or total of anything a person did', () => {
    // The exit criterion of Phase 4.3 as a property of the type. A `takenCount` here would hand
    // a screen everything it needs to draw a scorecard, which is where nobody would notice it.
    const view = doseHistory([record({ id: 'e1' }), record({ id: 'e2', eventKind: 'SKIPPED' })]);
    expect(Object.keys(view).sort()).toEqual(['emptyMessage', 'lines', 'unreadableCount']);
    for (const line of view.lines) {
      expect(Object.keys(line).sort()).toEqual([
        'id',
        'note',
        'presentation',
        'recordedOn',
        'scheduledOn',
      ]);
    }
  });

  it('exports no function that could compute one', () => {
    // Asserted over the module's own keys rather than trusted to review, because a count is the
    // single easiest thing to add here.
    const names = Object.keys(doseEvents);
    expect(names.filter((n) => /count|rate|streak|score|percent|total|adherence/i.test(n))).toEqual(
      [],
    );
  });

  it('keeps when it was recorded apart from when it was due', () => {
    // A dose due on Tuesday can be recorded on Wednesday. Merging the two misdates one of them.
    const view = doseHistory([
      record({ recordedAt: '2026-09-02T07:00:00.000Z', scheduledFor: '2026-09-01T20:00:00.000Z' }),
    ]);
    expect(view.lines[0]?.recordedOn).toBe('2026-09-02');
    expect(view.lines[0]?.scheduledOn).toBe('2026-09-01');
  });

  it('counts an event kind it cannot name rather than guessing at one', () => {
    // The presentation layer holds one description per kind and no default. Guessing would put a
    // sentence about somebody's medicine next to a date that makes it look recorded by them.
    const view = doseHistory([record({ id: 'e1' }), record({ id: 'e2', eventKind: 'TELEPORTED' })]);
    expect(view.lines).toHaveLength(1);
    expect(view.unreadableCount).toBe(1);
    expect(asDoseEventKind('TELEPORTED')).toBeNull();
    expect(asDoseEventKind('TAKEN')).toBe('TAKEN');
  });

  it('says nothing reassuring about an empty history', () => {
    // Nothing recorded means nothing recorded. It does not mean the medicine was taken, and a
    // screen that congratulated somebody on an empty list would be inventing an answer.
    const view = doseHistory([]);
    expect(view.lines).toEqual([]);
    expect(view.emptyMessage).toBe(DOSE_COPY.historyEmpty);
  });

  it('shows the note verbatim', () => {
    const view = doseHistory([record({ note: 'felt sick' })]);
    expect(view.lines[0]?.note).toBe('felt sick');
  });
});
