/**
 * The screen that says when a medicine is meant to be taken.
 *
 * Spec references: `04` Phase 4.1 (times are local wall-clock plus a zone; written directions are
 * preserved as entered), `09` (Kynviora never restates a prescriber's instruction), `18`,
 * DEC-045 (a control is withheld rather than drawn and disabled), migration `0020`, `DEV-045`,
 * `19`.
 *
 * WHY THIS SCREEN
 * `DEV-045` lived here, and it was invisible from the code: `mayEdit` fell back to `false` for a
 * medicine that had no schedule yet, so "Add a schedule" was not drawn on exactly the medicines
 * that needed it - which is the only state a newly added medicine is ever in. The cause was two
 * files away (a resource declared `EMPTY` discards its whole payload), but the symptom was this
 * component being handed `false`, and a test that renders it both ways is what pins the contract
 * between them.
 *
 * The second half is DEC-045's rule, which is a security-adjacent one: a caregiver who may only
 * look sees no editing controls at all, rather than greyed-out ones. A disabled button tells
 * somebody what they are not trusted with, which is a fact about the permission model they did
 * not need.
 */

import { describe, it, expect } from 'vitest';
import { SCHEDULE_COPY } from '@kynviora/presentation';
import { hasName, press, renderScreen, screenNames, textOf } from '../../../test/render.js';
import { MedicineSchedules, type MedicineSchedulesProps } from './MedicineSchedules';

const SCHEDULE = {
  id: 'sch-1',
  scheduleKind: 'FIXED_TIMES',
  timesLocal: ['08:00', '20:00'],
  daysOfWeek: null,
  timeZone: 'Asia/Kolkata',
  active: true,
  version: 1,
} as unknown as MedicineSchedulesProps['schedules'][number];

function screen(overrides: Partial<MedicineSchedulesProps> = {}) {
  const created: unknown[] = [];
  const updated: unknown[] = [];
  return renderScreen(
    <MedicineSchedules
      displayName="Synthetic Tablet A"
      directionsText="One tablet twice a day"
      schedules={[SCHEDULE]}
      listState="READY"
      detailLevel="GENERIC"
      remindersPermitted
      deviceTimeZone="Asia/Kolkata"
      mayEdit
      onCreate={(body) => created.push(body)}
      onUpdate={(id, body) => updated.push({ id, body })}
      onClose={() => undefined}
      {...overrides}
    />,
  );
}

describe('who is offered the editing controls', () => {
  it('offers "Add a schedule" to somebody who may edit', () => {
    expect(hasName(screen(), 'Add a schedule')).toBe(true);
  });

  it('still offers it when the medicine has no schedule yet', () => {
    // `DEV-045` exactly. A medicine with no schedule is the only state a newly added one is ever
    // in, and it is the state where "Add a schedule" is the entire point of the screen. The defect
    // reached here as `mayEdit: false`, so this is the assertion that says the two are unrelated.
    const rendered = screen({ schedules: [], listState: 'EMPTY' });
    expect(hasName(rendered, 'Add a schedule')).toBe(true);
  });

  it('withholds both controls from somebody who may only look', () => {
    // DEC-045: absent, not disabled. Asserted as absence from the whole screen rather than as a
    // disabled prop, because a disabled control still announces itself to a screen reader.
    const rendered = screen({ mayEdit: false });
    expect(hasName(rendered, 'Add a schedule')).toBe(false);
    expect(hasName(rendered, 'Change')).toBe(false);
  });

  it('still shows them the times, which is what viewing a medicine is for', () => {
    // The asymmetry is the point of the capability model, and a fix that took the read away too
    // would make the grant useless to the person holding it. Migration `0020` leaves `SELECT` at
    // item reachability for exactly this reason.
    const rendered = screen({ mayEdit: false });
    expect(screenNames(rendered).join(' ')).toContain('08:00');
  });

  it('leaves Done available to everybody', () => {
    // Withholding the way out of a screen is not a permission decision, and a person who can open
    // this has to be able to leave it.
    expect(hasName(screen({ mayEdit: false }), 'Done')).toBe(true);
  });
});

describe('what it says about the medicine', () => {
  it('puts the prescriber’s own words in front of whoever is setting the times', () => {
    // On the editor rather than the list, and that is the placement worth pinning: `09` forbids
    // Kynviora reinterpreting an instruction, and the moment somebody is about to encode one as a
    // set of times is exactly when the original wording has to be on screen. Verbatim, including
    // the case and the wording nobody here chose.
    const rendered = screen({ directionsText: 'ONE tablet TWICE a day, with food' });
    press(rendered, 'Change');
    expect(screenNames(rendered).join(' ')).toContain('ONE tablet TWICE a day, with food');
  });

  it('says none were recorded rather than inventing one', () => {
    // Never a placeholder and never this screen's guess at what the prescription said. An invented
    // instruction is the failure `09` is written to prevent, and an editor is where the temptation
    // to fill a blank field is greatest.
    const rendered = screen({ directionsText: null });
    press(rendered, 'Change');
    const text = screenNames(rendered).join(' ');
    expect(text).toContain(SCHEDULE_COPY.directionsMissing);
    expect(text).not.toMatch(/as directed|as prescribed|follow the label/i);
  });

  it('states what a locked screen would show, and how reliable a reminder is', () => {
    // Both are `18` disclosures rather than decoration: somebody deciding whether to set a
    // reminder needs to know what it will say in front of other people, and that a phone can
    // delay one.
    const rendered = screen();
    expect(hasName(rendered, SCHEDULE_COPY.reliability)).toBe(true);
  });

  it('warns when the phone will not show a reminder at all', () => {
    // A schedule that fires nothing is worse than no schedule, because the person believes they
    // will be told.
    expect(hasName(screen({ remindersPermitted: false }), SCHEDULE_COPY.notPermitted)).toBe(true);
    expect(hasName(screen({ remindersPermitted: true }), SCHEDULE_COPY.notPermitted)).toBe(false);
  });

  it('says nothing is scheduled rather than leaving the section blank', () => {
    const rendered = screen({ schedules: [], listState: 'EMPTY' });
    expect(screenNames(rendered).join(' ')).toContain('Nothing is scheduled for this medicine.');
  });
});

describe('opening the editor', () => {
  it('opens a blank form from "Add a schedule"', () => {
    const rendered = screen({ schedules: [], listState: 'EMPTY' });
    press(rendered, 'Add a schedule');
    // The form is open when the time field it owns is on screen.
    expect(hasName(rendered, { startsWith: SCHEDULE_COPY.timesLabel })).toBe(true);
  });

  it('opens the existing schedule from "Change"', () => {
    const rendered = screen();
    press(rendered, 'Change');
    expect(hasName(rendered, { startsWith: SCHEDULE_COPY.timesLabel })).toBe(true);
  });
});

describe('the schedule as it reads on the list', () => {
  it('names the zone beside the times, never instead of them', () => {
    // `04` Phase 4.1 stores a wall-clock time and a zone separately, because "08:00" survives a
    // daylight-saving transition and a flight while an instant does not. Both have to be on screen
    // or the time means nothing.
    const rendered = screen();
    const text = screenNames(rendered).join(' ');
    expect(text).toContain('Asia/Kolkata');
    expect(text).toContain('08:00');
  });

  it('renders a deactivated schedule as such rather than hiding it', () => {
    // A person asking "why is there no reminder" has to be able to answer it from this screen, so
    // an inactive schedule stays visible and says what it is.
    const rendered = screen({
      schedules: [{ ...SCHEDULE, active: false }],
    });
    expect(textOf(rendered.renderer.root)).not.toBe('');
    expect(screenNames(rendered).join(' ')).toContain('08:00');
  });
});
