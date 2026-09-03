import { describe, it, expect } from 'vitest';
import {
  REMINDER_DISCLOSURE_COPY,
  SCHEDULE_COPY,
  SCHEDULE_KIND_PRESENTATION,
  WEEKDAY_PRESENTATION,
  describeSchedule,
  reminderDisclosureOptions,
  scheduleKindOptions,
  weekdayOptions,
} from './schedule.js';
import {
  ISO_WEEKDAYS,
  NOTIFICATION_DETAIL_LEVELS,
  SCHEDULE_KINDS,
  type IsoWeekday,
} from '@kynviora/domain';

/**
 * The words beside the controls that decide when somebody is told to take a medicine.
 *
 * Two properties are asserted here rather than trusted: that every member of every vocabulary has
 * wording (trap 109, where a vocabulary grew a member and shipped a blank line), and that no
 * sentence on this screen states a dose.
 */

describe('every kind of schedule has words', () => {
  it('covers the vocabulary with no gaps', () => {
    for (const kind of SCHEDULE_KINDS) {
      const presentation = SCHEDULE_KIND_PRESENTATION[kind];
      expect(presentation.label.length).toBeGreaterThan(0);
      expect(presentation.description.length).toBeGreaterThan(0);
    }
    expect(scheduleKindOptions()).toHaveLength(SCHEDULE_KINDS.length);
  });

  it('says what as-needed means for a reminder, rather than only what it is', () => {
    // Somebody choosing it is entitled to know no reminder will arrive. "As needed" on its own
    // does not say that, and the person would find out by not being reminded.
    expect(SCHEDULE_KIND_PRESENTATION.AS_NEEDED.description).toMatch(/no reminders/i);
  });

  it('does not call it "no reminders", which sounds like something is switched off', () => {
    expect(SCHEDULE_KIND_PRESENTATION.AS_NEEDED.label).not.toMatch(/^no /i);
  });
});

describe('every weekday has a label and a spoken name', () => {
  it('covers ISO 1 through 7', () => {
    for (const day of ISO_WEEKDAYS) {
      expect(WEEKDAY_PRESENTATION[day].label.length).toBeGreaterThan(0);
      expect(WEEKDAY_PRESENTATION[day].accessibilityLabel.length).toBeGreaterThan(0);
    }
    expect(weekdayOptions().map((option) => option.day)).toEqual([...ISO_WEEKDAYS]);
  });

  it('starts on Monday, as the column does', () => {
    // A Sunday-first convention here would move every selected-day schedule by a day without
    // anything failing.
    expect(WEEKDAY_PRESENTATION[1].accessibilityLabel).toBe('Monday');
  });

  it('spells the day out for a screen reader', () => {
    // "Mon" is read aloud as a word rather than a day.
    for (const day of ISO_WEEKDAYS) {
      expect(WEEKDAY_PRESENTATION[day].accessibilityLabel.length).toBeGreaterThan(
        WEEKDAY_PRESENTATION[day].label.length,
      );
    }
  });
});

describe('what a reminder will put on a locked screen', () => {
  it('has a promise for every level', () => {
    for (const level of NOTIFICATION_DETAIL_LEVELS) {
      expect(REMINDER_DISCLOSURE_COPY[level].length).toBeGreaterThan(0);
    }
    expect(reminderDisclosureOptions()).toHaveLength(NOTIFICATION_DETAIL_LEVELS.length);
  });

  it('says the default reveals nothing, in terms of who could read it', () => {
    // Phase 4.2's second exit criterion is kept in code; this is where somebody is told about it,
    // on the screen where they decide whether to rely on reminders at all.
    expect(REMINDER_DISCLOSURE_COPY.GENERIC).toMatch(/locked screen/i);
    expect(REMINDER_DISCLOSURE_COPY.GENERIC).toMatch(/not learn|nobody/i);
  });

  it('does not describe the widest level as safe', () => {
    // `NAMED` is a real disclosure and the sentence has to say so. Reassuring wording here would
    // be the app talking somebody into a setting whose cost it then hid.
    expect(REMINDER_DISCLOSURE_COPY.NAMED).toMatch(/able to read/i);
    expect(REMINDER_DISCLOSURE_COPY.NAMED).not.toMatch(/\bsafe\b|\bprivate\b|\bsecure\b/i);
  });
});

describe('the words on the form', () => {
  it('attributes the directions rather than presenting them as Kynviora reading them', () => {
    // `09`: Kynviora does not reinterpret a prescription instruction. The label says whose words
    // they are, and the help says the interpreting is the person's.
    expect(SCHEDULE_COPY.directionsLabel).toMatch(/label or prescription says/i);
    expect(SCHEDULE_COPY.directionsHelp).toMatch(/does not work the times out/i);
  });

  it('is honest about what a reminder cannot do', () => {
    // `18` refuses the confident version. Somebody who stopped setting their own alarm because an
    // app promised to remind them is worse off than before they installed it.
    expect(SCHEDULE_COPY.reliability).toMatch(/phone is off or silent/i);
    expect(SCHEDULE_COPY.reliability).toMatch(/keep any alarm you already rely on/i);
  });

  it('says what stopping reminders does not delete', () => {
    expect(SCHEDULE_COPY.stopHelp).toMatch(/already recorded .* stays/i);
  });

  it('does not blame the person when the phone refuses notifications', () => {
    expect(SCHEDULE_COPY.notPermitted).toMatch(/this phone is not allowing/i);
    expect(SCHEDULE_COPY.notPermitted).not.toMatch(/you (did|have) not|you refused/i);
  });

  it('never states a dose or an amount anywhere on the screen', () => {
    // `09`. The one place a quantity could arrive on this screen is the directions, which are the
    // prescriber's own words and are rendered verbatim - never Kynviora's sentence.
    for (const sentence of Object.values(SCHEDULE_COPY)) {
      expect(sentence).not.toMatch(/\btake (one|two|three|\d)/i);
      expect(sentence).not.toMatch(/\b\d+\s?(mg|ml|mcg)\b/i);
    }
  });
});

describe('describing a stored schedule in one sentence', () => {
  const times = ['08:00', '20:00'];

  it('reads as a sentence rather than a row of fields', () => {
    expect(
      describeSchedule({ kind: 'FIXED_TIMES', timesLocal: times, daysOfWeek: null, active: true }),
    ).toBe('08:00, 20:00 every day.');
  });

  it('spells the days out', () => {
    expect(
      describeSchedule({
        kind: 'SELECTED_DAYS',
        timesLocal: ['09:00'],
        daysOfWeek: [1, 3] as readonly IsoWeekday[],
        active: true,
      }),
    ).toBe('09:00 on Monday, Wednesday.');
  });

  it('says an as-needed medicine gets no reminder', () => {
    expect(
      describeSchedule({ kind: 'AS_NEEDED', timesLocal: [], daysOfWeek: null, active: true }),
    ).toMatch(/no reminders/i);
  });

  it('says a stopped schedule is stopped before it says the times', () => {
    // Somebody scanning a list must not read the times and stop there, on a schedule that is
    // firing nothing.
    const line = describeSchedule({
      kind: 'FIXED_TIMES',
      timesLocal: times,
      daysOfWeek: null,
      active: false,
    });
    expect(line.indexOf('off')).toBeLessThan(line.indexOf('08:00'));
  });
});
