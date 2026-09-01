import { describe, it, expect } from 'vitest';
import { DOSE_EVENT_KINDS, type DoseEventKind } from '@kynviora/domain';
import {
  ALL_DOSE_STRINGS,
  DOSE_COPY,
  DOSE_EVENT_DESCRIPTIONS,
  DOSE_EVENT_ORDER,
  DOSE_EVENT_PRESENTATION,
  describeDoseEvent,
  presentDoseEvent,
  recordedOn,
} from './doseEvents.js';
import { findForbiddenClaims } from './copy.js';
import { ICON_NAMES } from './status.js';
import { LIGHT_THEME, contrastRatio, MIN_BODY_CONTRAST_RATIO } from './tokens.js';

/**
 * The copy is the exit criterion.
 *
 * `04` Phase 4.3 asks for a record "without gamifying or judging", and lists "copy avoids shame
 * and unsafe treatment recommendations" as what done looks like. There is no algorithm to test
 * here - the whole feature is whether the words on the screen judge somebody, so that is what
 * these assert.
 */

describe('every kind has words a person can read', () => {
  it('describes every kind the database accepts', () => {
    // The CHECK constraint accepts exactly these four. A kind the database accepts but the UI
    // cannot name would be recorded through a control that could not say what it meant.
    const missing = DOSE_EVENT_KINDS.filter((kind) => !(kind in DOSE_EVENT_DESCRIPTIONS));
    expect(missing).toEqual([]);
    expect(DOSE_EVENT_KINDS.filter((kind) => !(kind in DOSE_EVENT_PRESENTATION))).toEqual([]);
  });

  it('offers the controls in the vocabulary order', () => {
    expect(DOSE_EVENT_ORDER).toEqual(DOSE_EVENT_KINDS);
  });

  it('speaks in the first person for the action and the past tense for the record', () => {
    // The person is recording their own action, and reading back their own record.
    expect(describeDoseEvent('TAKEN').actionLabel).toMatch(/^I /);
    expect(describeDoseEvent('SKIPPED').actionLabel).toMatch(/^I /);
    expect(describeDoseEvent('TAKEN').recordedLabel).toBe('Taken');
  });
});

describe('nothing here judges or counts', () => {
  it('carries no score, rate, streak or grade in any string', () => {
    // `02` lists gamified adherence scoring as an anti-feature and `23` D-005 forbids the
    // aggregate. The absence has to be asserted somewhere, and the copy is where it would appear.
    // `notScored` is exempt, and only because it is the sentence saying there is no score.
    // It is asserted separately below rather than by loosening the scan.
    for (const text of ALL_DOSE_STRINGS.filter((t) => t !== DOSE_COPY.notScored)) {
      expect(text).not.toMatch(/\b(streak|score|scored|rate|percentage|grade|points|goal)\b/i);
      expect(text).not.toContain('%');
    }
    expect(DOSE_COPY.notScored).toMatch(/nothing here is scored or counted/i);
  });

  it('never uses the word "missed" for something a person recorded', () => {
    // `SKIPPED` and `UNABLE_TO_TAKE` are two different facts, and "missed" - the word for a
    // schedule that lapsed with nothing recorded - loses the difference that matters.
    for (const [kind, description] of Object.entries(DOSE_EVENT_DESCRIPTIONS)) {
      for (const text of [description.actionLabel, description.recordedLabel, description.meaning])
        expect(`${kind}: ${text}`).not.toMatch(/\bmissed\b/i);
    }
  });

  it('does not praise a taken dose or reproach a skipped one', () => {
    // Praise is the other half of shame, and the screen that congratulates you on Monday is the
    // one that has an opinion on Tuesday.
    for (const text of ALL_DOSE_STRINGS) {
      expect(text).not.toMatch(/\b(well done|good job|great|keep it up|try to|remember to)\b/i);
    }
  });

  it('never tells anyone what to do about a medicine', () => {
    // `09`: a history screen is a tempting place to slip in "ask your pharmacist", which is an
    // instruction dressed as concern.
    for (const text of ALL_DOSE_STRINGS) {
      expect(findForbiddenClaims(text)).toEqual([]);
      expect(text).not.toMatch(/\byou should\b/i);
    }
  });

  it('says nothing reassuring about an empty history', () => {
    // An empty record means nothing has been recorded. It does not mean the medicine was taken,
    // and it does not mean it was not.
    expect(DOSE_COPY.historyEmpty).toMatch(/nothing recorded/i);
    expect(DOSE_COPY.historyEmpty).not.toMatch(/\b(safe|fine|good|on track|up to date)\b/i);
  });
});

describe('how a recorded event looks', () => {
  it('gives every kind the same tone', () => {
    // A red chip on SKIPPED beside a green one on TAKEN is a scorecard drawn in colour.
    const tones = new Set(DOSE_EVENT_KINDS.map((kind) => presentDoseEvent(kind).tone));
    expect(tones.size).toBe(1);
    expect([...tones][0]).toBe('neutral');
  });

  it('keeps the kinds apart by shape instead', () => {
    // `18` forbids meaning through colour alone. With one shared tone the icon is what carries
    // the distinction, so the four must differ.
    const icons = DOSE_EVENT_KINDS.map((kind) => presentDoseEvent(kind).iconName);
    expect(new Set(icons).size).toBe(DOSE_EVENT_KINDS.length);
    for (const icon of icons) expect(ICON_NAMES).toContain(icon);
  });

  it('always carries a text label as well as an icon', () => {
    for (const kind of DOSE_EVENT_KINDS as readonly DoseEventKind[]) {
      const presentation = presentDoseEvent(kind);
      expect(presentation.label.length).toBeGreaterThan(0);
      expect(presentation.accessibilityLabel.length).toBeGreaterThan(0);
    }
  });

  it('reads well enough to be read', () => {
    for (const kind of DOSE_EVENT_KINDS as readonly DoseEventKind[]) {
      const tone = LIGHT_THEME[presentDoseEvent(kind).tone];
      expect(contrastRatio(tone.foreground, tone.background)).toBeGreaterThanOrEqual(
        MIN_BODY_CONTRAST_RATIO,
      );
    }
  });

  it('shows the date rather than a time to the second', () => {
    // Precision the person cannot check reads as certainty about a moment they may have entered
    // hours after it happened.
    expect(recordedOn('2026-09-01T14:32:07.123Z')).toBe('2026-09-01');
  });
});

describe('sentence shape', () => {
  it('keeps every sentence short enough to read on a phone', () => {
    // `18`: one idea per sentence for safety-critical content.
    for (const text of ALL_DOSE_STRINGS) {
      for (const sentence of text.split(/(?<=\.)\s+/)) {
        expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(20);
      }
    }
  });
});
