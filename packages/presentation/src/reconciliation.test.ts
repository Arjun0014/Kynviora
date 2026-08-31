import { describe, it, expect } from 'vitest';
import {
  ALL_RECONCILIATION_STRINGS,
  COMPARISON_EMPTY,
  DIFFERENCE_DESCRIPTIONS,
  FORBIDDEN_OPTION_FIELDS,
  KYNVIORA_VOICE_STRINGS,
  RECONCILIATION_COPY,
  RECONCILIATION_TONES,
  RESOLUTION_OPTIONS,
  completionMessage,
  describeDifference,
  everyDifferenceKindDescribed,
  everyResolutionOffered,
  optionsNeedingASide,
  presentSide,
  resolutionOption,
  summarizeComparison,
} from './reconciliation.js';
import { findForbiddenClaims } from './copy.js';
import { presentUrgency } from './status.js';
import { ACTION_URGENCIES, DIFFERENCE_KINDS, RECONCILIATION_RESOLUTIONS } from '@kynviora/domain';

describe('neither side is rendered as the answer', () => {
  it('gives both sides the same tone and the same emphasis', () => {
    // The exit criterion in pixels. By the time a difference reaches a screen, the domain and the
    // schema have both refused to hold an answer, so the only way left to choose one is visually.
    const previous = presentSide('PREVIOUS', '500 mg');
    const current = presentSide('CURRENT', '250 mg');

    expect(previous.tone).toBe(current.tone);
    expect(previous.emphasised).toBe(false);
    expect(current.emphasised).toBe(false);
  });

  it('labels each side by where it came from, not by whether it is right', () => {
    for (const side of ['PREVIOUS', 'CURRENT'] as const) {
      const label = presentSide(side, 'x').label;
      expect(label).not.toMatch(/\b(correct|right|wrong|outdated|accurate|actual|true|stale)\b/i);
    }
  });

  it('renders a missing value as a stated absence rather than an empty cell', () => {
    // A blank on one side is a real answer - the new list may simply not say - and an empty cell
    // reads as "nothing", which is a different claim.
    expect(presentSide('CURRENT', null).value).toBe('Not stated');
    expect(presentSide('CURRENT', '   ').value).toBe('Not stated');
    expect(presentSide('CURRENT', 'One tablet twice a day').value).toBe('One tablet twice a day');
  });

  it('uses none of the tones an alert uses for actionable urgency', () => {
    const alertTones = new Set(
      ACTION_URGENCIES.filter((u) => u !== 'LOW' && u !== 'INFORMATIONAL').map(
        (u) => presentUrgency(u).tone,
      ),
    );
    expect(alertTones.size).toBeGreaterThan(0);
    for (const tone of RECONCILIATION_TONES) {
      expect(alertTones.has(tone)).toBe(false);
    }
  });

  it('gives every difference kind a permitted tone and words of its own', () => {
    expect(everyDifferenceKindDescribed()).toBe(true);
    for (const kind of DIFFERENCE_KINDS) {
      expect(RECONCILIATION_TONES).toContain(describeDifference(kind).tone);
    }
  });
});

describe('a missing medicine is not described as a stopped one', () => {
  it('says Kynviora cannot tell why it is absent', () => {
    // The sharpest case in the phase: a medicine absent from a discharge summary may have been
    // changed, or the summary may only cover the admission, and those have opposite correct
    // actions. Naming one would be choosing.
    const description = DIFFERENCE_DESCRIPTIONS.ONLY_IN_PREVIOUS;
    expect(description.meaning).toMatch(/cannot tell/i);
    expect(`${description.heading} ${description.meaning}`).not.toMatch(
      /\b(stopped|discontinued|no longer|removed|cancelled)\b/i,
    );
  });

  it('does not describe a newly-listed medicine as one to begin', () => {
    const description = DIFFERENCE_DESCRIPTIONS.ONLY_IN_CURRENT;
    expect(`${description.heading} ${description.meaning}`).not.toMatch(
      /\b(start taking|begin taking|newly prescribed)\b/i,
    );
  });

  it('does not render agreement as good news', () => {
    // "The two lists agree" is a fact about two documents. Rendering it as positive would make
    // its opposite read as negative, which is a verdict on a medicine.
    expect(DIFFERENCE_DESCRIPTIONS.MATCHES.tone).toBe('neutral');
    expect(DIFFERENCE_DESCRIPTIONS.MATCHES.meaning).not.toMatch(/\b(good|great|well done|safe)\b/i);
  });
});

describe('the options never recommend one', () => {
  it('offers every resolution the domain can record', () => {
    expect(everyResolutionOffered()).toBe(true);
    expect(RESOLUTION_OPTIONS.map((o) => o.resolution)).toEqual([...RECONCILIATION_RESOLUTIONS]);
  });

  it('carries no field that marks an option as preferred', () => {
    // Asserted against the object's own keys, so a `recommended: false` cannot be added today and
    // flipped tomorrow. A pre-selected option is a recommendation whatever it is called.
    for (const option of RESOLUTION_OPTIONS) {
      for (const forbidden of FORBIDDEN_OPTION_FIELDS) {
        expect(Object.keys(option)).not.toContain(forbidden);
      }
    }
  });

  it('makes the screen ask which value a professional confirmed', () => {
    // "The pharmacist confirmed it" does not say which value they confirmed, and they may well
    // have confirmed the older one. Assuming the newer would be Kynviora choosing.
    expect(optionsNeedingASide()).toEqual([
      'CONFIRMED_WITH_PRESCRIBER',
      'CONFIRMED_WITH_PHARMACIST',
      'CONFIRMED_FROM_DOCUMENT',
    ]);
  });

  it('fixes the side only for the two options that name it themselves', () => {
    expect(resolutionOption('USER_KEPT_PREVIOUS').fixedSide).toBe('PREVIOUS');
    expect(resolutionOption('USER_ADOPTED_CURRENT').fixedSide).toBe('CURRENT');
    expect(resolutionOption('STILL_UNRESOLVED').fixedSide).toBeNull();
  });

  it('requires a name for a professional confirmation and nothing else', () => {
    const needName = RESOLUTION_OPTIONS.filter((o) => o.needsName).map((o) => o.resolution);
    expect(needName).toEqual(['CONFIRMED_WITH_PRESCRIBER', 'CONFIRMED_WITH_PHARMACIST']);
  });

  it('writes the user own choices in the first person', () => {
    // An imperative on a button is Kynviora telling someone what to do with a medicine. The first
    // person makes it the user's statement, which is what it is.
    expect(resolutionOption('USER_KEPT_PREVIOUS').label).toMatch(/^I'm |^I /);
    expect(resolutionOption('USER_ADOPTED_CURRENT').label).toMatch(/^I'm |^I /);
    expect(resolutionOption('STILL_UNRESOLVED').label).toMatch(/^I'm |^I /);
  });

  it('treats leaving a difference open as a normal outcome', () => {
    const option = resolutionOption('STILL_UNRESOLVED');
    expect(option.settles).toBe(false);
    expect(option.meaning).not.toMatch(/\b(must|required|incomplete|failed|error)\b/i);
  });
});

describe('the copy says what Kynviora will not do', () => {
  it('states plainly that it will not pick a version', () => {
    expect(RECONCILIATION_COPY.neitherIsChosen).toMatch(/does not know/i);
    expect(RECONCILIATION_COPY.neitherIsChosen).toMatch(/will not pick/i);
  });

  it('routes the question to a professional', () => {
    // 04 Phase 8.5 lists a "confirm with clinician/pharmacist" workflow. It is phrased as a route
    // to a person, not as an instruction about the medicine.
    expect(RECONCILIATION_COPY.whoToAsk).toMatch(/prescriber|pharmacist/i);
  });

  it('states the limitation rather than implying it', () => {
    expect(RECONCILIATION_COPY.limitation).toMatch(/not a check/i);
  });

  it('publishes no forbidden claim', () => {
    for (const text of ALL_RECONCILIATION_STRINGS) {
      expect(findForbiddenClaims(text)).toEqual([]);
    }
  });

  it('never tells anyone what to do with a medicine in Kynviora own voice', () => {
    // Scoped to the strings Kynviora says. The resolution labels are the user's voice - "I'm
    // going with the new list" is their statement - and scanning those with this rule would make
    // the user's own choices unsayable.
    for (const text of KYNVIORA_VOICE_STRINGS) {
      expect(text).not.toMatch(
        /\b(?:take|stop|start|switch|split|double|halve|skip)\s+(?:taking\s+)?(?:the|your|this|a)\s+(?:medicine|medication|tablet|dose|drug|prescription)\b/i,
      );
    }
  });

  it('does not shame anyone for an out-of-date record', () => {
    for (const text of ALL_RECONCILIATION_STRINGS) {
      expect(text).not.toMatch(/\b(you should have|you failed|out of date|neglected|careless)\b/i);
    }
  });

  it('says the directions are reproduced rather than rewritten', () => {
    // 04 Phase 4.1 forbids rewriting a prescription instruction, and a comparison that showed a
    // paraphrase would be comparing its own words.
    expect(RECONCILIATION_COPY.verbatimNote).toMatch(/exactly as/i);
  });
});

describe('the completion message', () => {
  it('does not treat open questions as a failure', () => {
    for (const count of [0, 1, 4]) {
      const message = completionMessage(count);
      expect(message).not.toMatch(/\b(incomplete|failed|error|unfinished|problem)\b/i);
    }
  });

  it('says how many are still open, in plain words', () => {
    expect(completionMessage(0)).toMatch(/all done/i);
    expect(completionMessage(1)).toMatch(/one difference/i);
    expect(completionMessage(4)).toContain('4 differences');
  });
});

describe('the comparison summary', () => {
  const differences = [
    {
      differenceId: 'd1',
      kind: 'FIELD_DIFFERS' as const,
      displayName: 'Synthetic Tablet A',
      field: 'strengthText',
      previousValue: '500 mg',
      currentValue: '250 mg',
      resolution: null,
    },
    {
      differenceId: 'd2',
      kind: 'MATCHES' as const,
      displayName: 'Synthetic Tablet B',
      field: null,
      previousValue: null,
      currentValue: null,
      resolution: null,
    },
    {
      differenceId: 'd3',
      kind: 'ONLY_IN_PREVIOUS' as const,
      displayName: 'Synthetic Tablet C',
      field: null,
      previousValue: null,
      currentValue: null,
      resolution: 'STILL_UNRESOLVED' as const,
    },
  ];

  it('shows both sides of a field difference, in reading order', () => {
    const summary = summarizeComparison(differences);
    const line = summary.lines[0];
    expect(line?.sides.map((s) => s.side)).toEqual(['PREVIOUS', 'CURRENT']);
    expect(line?.sides.map((s) => s.value)).toEqual(['500 mg', '250 mg']);
    expect(line?.fieldLabel).toBe('Strength');
  });

  it('reports agreement as well as disagreement', () => {
    // A list showing only problems misrepresents the scale of what changed, which is the most
    // reassuring thing a reconciliation can get right.
    const summary = summarizeComparison(differences);
    expect(summary.agreeingCount).toBe(1);
    expect(summary.differingCount).toBe(2);
  });

  it('counts an unresolved difference as not settled', () => {
    expect(summarizeComparison(differences).settledCount).toBe(0);
    expect(
      summarizeComparison([
        { ...differences[0]!, resolution: 'CONFIRMED_WITH_PHARMACIST' as const },
      ]).settledCount,
    ).toBe(1);
  });

  it('keeps the order it was given rather than ranking by importance', () => {
    // Sorting by importance would require ranking one medicine's disagreement above another's,
    // which is a clinical judgement.
    const summary = summarizeComparison(differences);
    expect(summary.lines.map((l) => l.differenceId)).toEqual(['d1', 'd2', 'd3']);
  });

  it('carries no sides on a difference that is not about a field', () => {
    const summary = summarizeComparison(differences);
    expect(summary.lines[1]?.sides).toEqual([]);
    expect(summary.lines[2]?.sides).toEqual([]);
  });

  it('says so when there is nothing to compare', () => {
    const summary = summarizeComparison([]);
    expect(summary.emptyMessage).toBe(COMPARISON_EMPTY);
    expect(summary.lines).toEqual([]);
  });

  it('states the limitation on every summary', () => {
    expect(summarizeComparison([]).limitation).toBe(RECONCILIATION_COPY.limitation);
  });
});
