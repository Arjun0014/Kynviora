/**
 * The screen that records what happened with a medicine.
 *
 * Spec references: `04` Phase 4.3 ("record what happened without gamifying or judging them"),
 * `02` (gamified adherence scoring is an anti-feature), `12` (a queued change is visible rather
 * than assumed), `18` (no shame; one idea per sentence), `19`, `DEV-048`, DEC-111.
 *
 * WHY THIS SCREEN FIRST
 * Two of its decisions are the kind a device run can only reach by driving eleven minutes of app,
 * and both are about a sentence somebody acts on. `OFF-6` measures the first on hardware: a dose
 * kept on the phone must **not** say "Recorded.", because that is the shorter promise and it is
 * the one that stops a person recording the same dose again. The second is `02`'s: four controls
 * of equal weight, because a screen with a preference about whether somebody took their medicine
 * is judging them before they have answered.
 *
 * Neither is visible from the types, and until now nothing checked either without a phone.
 */

import { describe, it, expect } from 'vitest';
import { DOSE_COPY, DOSE_EVENT_DESCRIPTIONS } from '@kynviora/presentation';
import { DOSE_EVENT_KINDS } from '@kynviora/domain';
import { doseHistory, type DoseHistoryView } from '@kynviora/contracts';
import {
  findByName,
  hasName,
  press,
  renderScreen,
  screenNames,
  typeInto,
} from '../../../test/render.js';
import { RecordDose } from './RecordDose';

const EMPTY_HISTORY: DoseHistoryView = doseHistory([]);

/** A history built by the contract's own function, so the shape is the one the app really gets. */
const ONE_LINE: DoseHistoryView = doseHistory([
  {
    id: 'e1',
    eventKind: 'TAKEN',
    recordedAt: '2026-09-04T09:00:00.000Z',
    scheduledFor: null,
    note: null,
  } as never,
]);

function screen(overrides: Partial<Parameters<typeof RecordDose>[0]> = {}) {
  const recorded: { body: unknown }[] = [];
  const rendered = renderScreen(
    <RecordDose
      ownedItemId="item-1"
      itemKind="MEDICINE"
      displayName="Synthetic Tablet A"
      onRecord={(body) => recorded.push({ body })}
      onClose={() => undefined}
      history={EMPTY_HISTORY}
      historyState="EMPTY"
      {...overrides}
    />,
  );
  return { rendered, recorded };
}

describe('the four controls', () => {
  it('offers one for every kind the vocabulary has, and no more', () => {
    // The list is built from the vocabulary rather than written out, so a kind added later without
    // a control would be a kind nobody can record. Asserted against the domain's own list.
    const { rendered } = screen();
    for (const kind of DOSE_EVENT_KINDS) {
      expect(hasName(rendered, DOSE_EVENT_DESCRIPTIONS[kind].actionLabel)).toBe(true);
    }
  });

  it('gives none of them more weight than the others', () => {
    // `02` and `04` Phase 4.3. One emphasised button is a preference, and a preference about
    // whether somebody took their medicine is a judgement expressed in a button style. Measured as
    // the variant every one of them is drawn with, which is the only thing that could differ.
    const { rendered } = screen();
    const variants = DOSE_EVENT_KINDS.map((kind) => {
      const node = findByName(rendered, DOSE_EVENT_DESCRIPTIONS[kind].actionLabel);
      return (node?.props['accessibilityState'] as { disabled?: boolean } | undefined)?.disabled;
    });
    expect(new Set(variants).size).toBe(1);

    const styles = DOSE_EVENT_KINDS.map((kind) => {
      const node = findByName(rendered, DOSE_EVENT_DESCRIPTIONS[kind].actionLabel);
      const style = node?.props['style'] as readonly Record<string, unknown>[] | undefined;
      const tone = style?.find(
        (part) => part !== null && typeof part === 'object' && 'backgroundColor' in part,
      );
      return tone?.['backgroundColor'];
    });
    expect(new Set(styles).size).toBe(1);
  });

  it('records the kind that was pressed', () => {
    const { rendered, recorded } = screen();
    press(rendered, DOSE_EVENT_DESCRIPTIONS.SKIPPED.actionLabel);
    expect(recorded).toHaveLength(1);
    expect((recorded[0]?.body as { eventKind: string }).eventKind).toBe('SKIPPED');
  });

  it('sends the note exactly as it was typed', () => {
    // `04` Phase 4.1's rule about not rewriting an instruction, one step over: the note is the
    // person's own account of what happened to them, and nothing here trims it to a summary.
    const { rendered, recorded } = screen();
    typeInto(rendered, DOSE_COPY.noteLabel, '  felt sick, waited an hour  ');
    press(rendered, DOSE_EVENT_DESCRIPTIONS.TAKEN.actionLabel);
    expect((recorded[0]?.body as { note?: string }).note).toBe('  felt sick, waited an hour  ');
  });
});

describe('what it says afterwards', () => {
  it('says "Recorded." only when the server has it', () => {
    const { rendered } = screen({ recorded: true });
    expect(hasName(rendered, DOSE_COPY.recordedDone)).toBe(true);
    expect(hasName(rendered, DOSE_COPY.offlineNote)).toBe(false);
  });

  it('says where the dose actually is when it is only on the phone', () => {
    // `OFF-6` on a device, and the half that matters: the queued sentence says where the record is
    // and when it will move, because a person told their record was safe and then reinstalling the
    // app would find it gone (`12`).
    const { rendered } = screen({ queued: true });
    expect(hasName(rendered, DOSE_COPY.offlineNote)).toBe(true);
  });

  it('never says both', () => {
    // Said *instead of* "Recorded.", never as well as it. Two promises about one dose, one of them
    // false, is how somebody records the same dose twice - and this is the assertion that would
    // fail if a later edit turned the second block from `queued` into an unconditional render.
    const { rendered } = screen({ queued: true, recorded: false });
    expect(hasName(rendered, DOSE_COPY.recordedDone)).toBe(false);
    expect(hasName(rendered, DOSE_COPY.offlineNote)).toBe(true);
  });

  it('says neither before anything has been recorded', () => {
    const { rendered } = screen();
    expect(hasName(rendered, DOSE_COPY.recordedDone)).toBe(false);
    expect(hasName(rendered, DOSE_COPY.offlineNote)).toBe(false);
  });
});

describe('what the screen refuses to show', () => {
  it('says out loud that nothing is being scored', () => {
    // `02` lists gamified adherence scoring as an anti-feature, and an absent score cannot state
    // itself. Somebody about to record a skipped dose is entitled to know nothing is counting.
    const { rendered } = screen();
    expect(hasName(rendered, DOSE_COPY.notScored)).toBe(true);
  });

  it('draws no number that could become a score', () => {
    // The strong form of the same rule, over the whole screen: no percentage, no streak, no "3 of
    // 7". `doseHistory` returns nothing that could become one, so there should be nothing here to
    // render even by accident - and this is what would notice if a later change added a count.
    const { rendered } = screen({ history: ONE_LINE, historyState: 'READY' });
    for (const name of screenNames(rendered)) {
      expect(name).not.toMatch(/\b\d+\s*(of|\/)\s*\d+\b/);
      expect(name).not.toMatch(/\b\d+%/);
      expect(name).not.toMatch(/streak/i);
    }
  });

  it('says nothing recorded rather than anything encouraging, when there is nothing', () => {
    // Not "well done" and not "nothing to report". `18` forbids both directions of judgement, and
    // an empty history is the place a cheerful sentence is most tempting.
    const { rendered } = screen({ historyState: 'READY' });
    expect(hasName(rendered, DOSE_COPY.historyEmpty)).toBe(true);
  });
});
