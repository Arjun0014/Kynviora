import { describe, it, expect } from 'vitest';
import {
  emptyScheduleForm,
  scheduleBodyFrom,
  scheduleChangeBodyFrom,
  scheduleFormComplete,
  scheduleFormFrom,
  scheduleFormRefusal,
  withDayToggled,
  withKindChanged,
  withTimeAdded,
  withTimeChanged,
  withTimeRemoved,
} from './scheduleForm.js';
import type { Schedule } from './client.js';

/**
 * The form that decides when somebody is told to take a medicine.
 *
 * The property that matters most here is a negative one: **nothing repairs a value.** A time
 * Kynviora quietly reinterpreted is one a person cannot check against what they meant, and what
 * it decides is when they take a tablet.
 */

const ZONE = 'Asia/Kolkata';

describe('a blank form', () => {
  it('starts with one time control to type into', () => {
    const form = emptyScheduleForm(ZONE);
    expect(form.timesLocal).toEqual(['']);
    expect(form.scheduleKind).toBe('FIXED_TIMES');
    expect(form.timeZone).toBe(ZONE);
  });

  it('takes the zone rather than asking the platform for it', () => {
    // DEC-002: this package does no I/O. A zone guessed here would also be the device's rather
    // than the schedule's, which is the distinction `04` Phase 4.1 exists to keep.
    expect(emptyScheduleForm('Europe/London').timeZone).toBe('Europe/London');
  });

  it('cannot be saved until a time is entered', () => {
    expect(scheduleFormComplete(emptyScheduleForm(ZONE))).toBe(false);
    expect(scheduleFormRefusal(emptyScheduleForm(ZONE))?.field).toBe('timesLocal');
  });
});

describe('editing an existing schedule', () => {
  const stored: Schedule = {
    id: 's1',
    ownedItemId: 'i1',
    scheduleKind: 'SELECTED_DAYS',
    timesLocal: ['09:00'],
    daysOfWeek: [1, 4],
    timeZone: ZONE,
    startsOn: '2026-09-01',
    endsOn: null,
    active: true,
    version: 3,
    updatedAt: null,
  };

  it('fills the form from what is stored', () => {
    const form = scheduleFormFrom(stored);
    expect(form.timesLocal).toEqual(['09:00']);
    expect(form.daysOfWeek).toEqual([1, 4]);
    expect(form.startsOn).toBe('2026-09-01');
    expect(form.endsOn).toBe('');
  });

  it('round-trips: filling the form and sending it back is the same schedule', () => {
    // The property the item editor already has. A prefill that got one field wrong would clear a
    // value nobody touched, the write would succeed, and nothing else would notice.
    const body = scheduleBodyFrom(scheduleFormFrom(stored));
    expect(body.scheduleKind).toBe('SELECTED_DAYS');
    expect(body.timesLocal).toEqual(['09:00']);
    expect(body.daysOfWeek).toEqual([1, 4]);
    expect(body.startsOn).toBe('2026-09-01');
    expect(body.endsOn).toBeNull();
  });

  it('carries the version the editor was looking at', () => {
    expect(scheduleChangeBodyFrom(scheduleFormFrom(stored), stored.version).expectedVersion).toBe(
      3,
    );
  });

  it('says nothing about the active flag unless asked to', () => {
    // Absent leaves it alone. A body that always sent `active: true` would silently restart
    // reminders somebody had stopped, on an unrelated edit.
    expect('active' in scheduleChangeBodyFrom(scheduleFormFrom(stored), 3)).toBe(false);
    expect(scheduleChangeBodyFrom(scheduleFormFrom(stored), 3, false).active).toBe(false);
  });

  it('keeps an as-needed schedule editable rather than showing an empty control', () => {
    const asNeeded = scheduleFormFrom({ ...stored, scheduleKind: 'AS_NEEDED', timesLocal: [] });
    expect(asNeeded.timesLocal).toEqual(['']);
  });
});

describe('what gets sent', () => {
  const filled = { ...emptyScheduleForm(ZONE), timesLocal: ['08:00', '20:00'] };

  it('drops a blank line rather than sending it', () => {
    // An empty control is one somebody has not filled in, not a time they meant.
    const body = scheduleBodyFrom({ ...filled, timesLocal: ['08:00', '', '20:00'] });
    expect(body.timesLocal).toEqual(['08:00', '20:00']);
  });

  it('sends what was typed, character for character', () => {
    // Not rounded to the nearest five minutes, not normalised, not corrected. The domain refuses
    // and names the field; the client sends what it was given.
    expect(scheduleBodyFrom({ ...filled, timesLocal: [' 08:07 '] }).timesLocal).toEqual(['08:07']);
    expect(scheduleBodyFrom({ ...filled, timesLocal: ['8:00'] }).timesLocal).toEqual(['8:00']);
  });

  it('clears the times when the medicine is taken only as needed', () => {
    // The kind and the data must not disagree, or the row is read by whichever the reader looks
    // at - and a reminder engine reading the times would fire on a medicine nobody scheduled.
    const body = scheduleBodyFrom({ ...filled, scheduleKind: 'AS_NEEDED' });
    expect(body.timesLocal).toEqual([]);
    expect(body.daysOfWeek).toBeNull();
  });

  it('sends no weekdays unless the kind is selected days', () => {
    const body = scheduleBodyFrom({ ...filled, daysOfWeek: [1, 2] });
    expect(body.daysOfWeek).toBeNull();
  });

  it('sends weekdays in order', () => {
    const body = scheduleBodyFrom({
      ...filled,
      scheduleKind: 'SELECTED_DAYS',
      daysOfWeek: [5, 1, 3],
    });
    expect(body.daysOfWeek).toEqual([1, 3, 5]);
  });

  it('treats a blank date as absent rather than as a value', () => {
    const body = scheduleBodyFrom({ ...filled, startsOn: '  ', endsOn: '2026-10-01' });
    expect(body.startsOn).toBeNull();
    expect(body.endsOn).toBe('2026-10-01');
  });

  it('has no field for a dose, a quantity or an instruction', () => {
    // `09`. A schedule says when. The prescriber's wording stays on the item, in their words.
    const body = scheduleBodyFrom(filled);
    for (const forbidden of ['dose', 'quantity', 'amount', 'directionsText', 'strength']) {
      expect(Object.keys(body)).not.toContain(forbidden);
    }
  });
});

describe('the refusal a person reads', () => {
  const filled = { ...emptyScheduleForm(ZONE), timesLocal: ['08:00'] };

  it('is the same refusal the server would give, about the same field', () => {
    // Run through `normalizeScheduleEntry`, the same function the route runs. A second, looser
    // copy here is how a client comes to accept something the server then rejects with a sentence
    // nobody wrote.
    expect(scheduleFormRefusal({ ...filled, timesLocal: ['8am'] })?.field).toBe('timesLocal');
    expect(scheduleFormRefusal({ ...filled, timeZone: 'Mars/Olympus' })?.field).toBe('timeZone');
    expect(
      scheduleFormRefusal({ ...filled, startsOn: '2026-10-01', endsOn: '2026-09-01' })?.field,
    ).toBe('endsOn');
  });

  it('refuses selected days with none chosen, rather than reading it as every day', () => {
    // The first version of this form sent `null` when nothing was ticked, and `null` means every
    // day. Somebody who chose "on certain days" and picked none would have been reminded seven
    // days a week - Kynviora answering a question they had not answered, in the direction that
    // interrupts them most.
    const values = { ...filled, scheduleKind: 'SELECTED_DAYS' as const, daysOfWeek: [] };
    expect(scheduleBodyFrom(values).daysOfWeek).toEqual([]);
    expect(scheduleFormRefusal(values)?.field).toBe('daysOfWeek');
    expect(scheduleFormComplete(values)).toBe(false);
  });

  it('still lets every day be chosen explicitly', () => {
    const values = {
      ...filled,
      scheduleKind: 'SELECTED_DAYS' as const,
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7] as const,
    };
    expect(scheduleFormRefusal(values)).toBeNull();
  });

  it('is null for an as-needed medicine with no times', () => {
    expect(
      scheduleFormRefusal({ ...emptyScheduleForm(ZONE), scheduleKind: 'AS_NEEDED' }),
    ).toBeNull();
  });
});

describe('editing the form', () => {
  const form = emptyScheduleForm(ZONE);

  it('adds and removes time lines', () => {
    const two = withTimeAdded(form);
    expect(two.timesLocal).toHaveLength(2);
    expect(withTimeRemoved(two, 0).timesLocal).toHaveLength(1);
  });

  it('always leaves one control to type into', () => {
    // Removing the last line would leave a form with no way to enter a time and no way to add one
    // back except a control the screen would have to grow a special case for.
    expect(withTimeRemoved(form, 0).timesLocal).toEqual(['']);
  });

  it('changes one line without touching the others', () => {
    const two = withTimeChanged(withTimeAdded(form), 1, '20:00');
    expect(two.timesLocal).toEqual(['', '20:00']);
  });

  it('toggles a weekday on and off, in order', () => {
    const on = withDayToggled(withDayToggled(form, 3), 1);
    expect(on.daysOfWeek).toEqual([1, 3]);
    expect(withDayToggled(on, 1).daysOfWeek).toEqual([3]);
  });

  it('keeps what was typed when the kind changes', () => {
    // Somebody who taps "only when I need it" to read what it means and taps back has not lost
    // their times. What is *sent* is decided at save.
    const typed = withTimeChanged(form, 0, '08:00');
    const asNeeded = withKindChanged(typed, 'AS_NEEDED');
    expect(asNeeded.timesLocal).toEqual(['08:00']);
    expect(scheduleBodyFrom(asNeeded).timesLocal).toEqual([]);
    expect(scheduleBodyFrom(withKindChanged(asNeeded, 'FIXED_TIMES')).timesLocal).toEqual([
      '08:00',
    ]);
  });
});
