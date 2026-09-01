import { describe, it, expect } from 'vitest';
import { CHANGE_ATTRIBUTIONS, CORRECTION_KINDS, calendarDate, instantFrom } from '@kynviora/domain';
import {
  attributeChange,
  diffRegulatoryVersions,
  diffUserAction,
  type RegulatoryDiff,
} from './diff.js';
import type { RegulatoryRuleVersion } from './records.js';
import {
  ATTRIBUTION_PRESENTATION,
  regulatoryDiffView,
  type RegulatoryDiffInput,
} from '@kynviora/presentation';

/**
 * Phase 7.4's regulatory half.
 *
 * The exit criterion - "users can distinguish a new regulator action from a Kynviora correction" -
 * is the subject of the first block, and the shape of the answer is the point: it is read from
 * what was recorded, never derived from what the two versions look like.
 *
 * This file also holds the cross-package check. `@kynviora/presentation` declares the diff shape
 * structurally rather than importing it, because the registry is not carried in the Expo bundle;
 * this is the one suite where both packages are present, so this is where the two are pinned
 * together.
 */

const BASE: RegulatoryRuleVersion = {
  id: 'v1',
  jurisdiction: 'GB',
  substanceCanonicalKey: 'synthetic.substance',
  statuses: ['RESTRICTED', 'CONCENTRATION_LIMIT'],
  conditions: { maxConcentrationPercent: 2, prohibitedRoutes: ['inhalation'] },
  legalInstrument: 'Synthetic Instrument',
  legalReference: 'Annex III, entry 1',
  publicationDate: calendarDate('2026-01-01'),
  effectiveDate: calendarDate('2026-02-01'),
  sourceRegistryEntryId: 's1',
  sourceDocumentId: 'd1',
  extractionVersion: '1.0.0',
  reviewState: 'PUBLISHED',
  verification: 'VERIFIED_AGAINST_OFFICIAL_SOURCE',
  approvedByReviewerId: 'synthetic-test-reviewer',
  approvedAt: instantFrom('2026-01-02T00:00:00.000Z'),
  supersedesRuleVersionId: null,
  createdAt: instantFrom('2026-01-02T00:00:00.000Z'),
};

function version(overrides: Partial<RegulatoryRuleVersion> = {}): RegulatoryRuleVersion {
  return { ...BASE, ...overrides };
}

// ---------------------------------------------------------------------------

describe('attributing a change', () => {
  it('says the regulator acted for a superseding version with no correction recorded', () => {
    expect(attributeChange({ correctionKind: null, supersedesEarlierVersion: true })).toBe(
      'REGULATOR_ACTED',
    );
  });

  it('says Kynviora corrected itself when a correction was recorded', () => {
    for (const kind of CORRECTION_KINDS.filter((k) => k !== 'SOURCE_CORRECTED')) {
      expect(attributeChange({ correctionKind: kind, supersedesEarlierVersion: true })).toBe(
        'KYNVIORA_CORRECTED_ITSELF',
      );
    }
  });

  it('keeps the source correcting itself apart from both', () => {
    // A third honest case. "The law changed", "the regulator corrected what it said" and "we read
    // it wrong" call for different amounts of trust in what the person was told before.
    expect(
      attributeChange({ correctionKind: 'SOURCE_CORRECTED', supersedesEarlierVersion: true }),
    ).toBe('SOURCE_CORRECTED_ITSELF');
  });

  it('a correction outranks a supersession, because the correction is the recorded fact', () => {
    expect(
      attributeChange({ correctionKind: 'RULE_CORRECTED', supersedesEarlierVersion: true }),
    ).toBe('KYNVIORA_CORRECTED_ITSELF');
  });

  it('refuses to attribute a change nobody recorded', () => {
    // `NOT_STATED` is a member rather than a fallback. Defaulting it to a regulator action would
    // hand Kynviora's mistakes to the regulator; defaulting it to a correction would claim a
    // mistake nobody found.
    expect(attributeChange({ correctionKind: null, supersedesEarlierVersion: false })).toBe(
      'NOT_STATED',
    );
    expect(attributeChange({ correctionKind: '  ', supersedesEarlierVersion: false })).toBe(
      'NOT_STATED',
    );
  });

  it('attributes an unrecognised correction kind to Kynviora, never to the regulator', () => {
    // The one wrong direction. The criterion exists so a reader can tell when the software was
    // wrong, and a value this build does not know must not become "the law changed".
    expect(
      attributeChange({ correctionKind: 'SOMETHING_NEW', supersedesEarlierVersion: true }),
    ).toBe('KYNVIORA_CORRECTED_ITSELF');
  });

  it('produces only members of the vocabulary', () => {
    for (const kind of [...CORRECTION_KINDS, null, 'SOMETHING_NEW']) {
      for (const supersedes of [true, false]) {
        expect(CHANGE_ATTRIBUTIONS).toContain(
          attributeChange({ correctionKind: kind, supersedesEarlierVersion: supersedes }),
        );
      }
    }
  });
});

describe('the diff itself', () => {
  it('reports an identical pair as no change', () => {
    const diff = diffRegulatoryVersions(version(), version({ id: 'v2' }));
    expect(diff.anyChange).toBe(false);
    expect(diff.statusesAdded).toEqual([]);
    expect(diff.statusesRemoved).toEqual([]);
    expect(diff.conditionsChanged).toEqual([]);
  });

  it('reports statuses added and removed as two lists, never as one replacement', () => {
    // `07` forbids collapsing several applicable statuses into one, and the same applies to a
    // change: "RESTRICTED became PROHIBITED" is a sentence about severity that nobody wrote.
    const diff = diffRegulatoryVersions(
      version({ statuses: ['RESTRICTED', 'CONCENTRATION_LIMIT'] }),
      version({ id: 'v2', statuses: ['PROHIBITED', 'CONCENTRATION_LIMIT'] }),
    );
    expect(diff.statusesAdded).toEqual(['PROHIBITED']);
    expect(diff.statusesRemoved).toEqual(['RESTRICTED']);
  });

  it('reports a changed condition with both values and no third', () => {
    const diff = diffRegulatoryVersions(
      version({ conditions: { maxConcentrationPercent: 2 } }),
      version({ id: 'v2', conditions: { maxConcentrationPercent: 0.5 } }),
    );
    const change = diff.conditionsChanged.find((c) => c.key === 'maxConcentrationPercent');
    expect(change?.previousValue).toBe('2');
    expect(change?.currentValue).toBe('0.5');
    expect(Object.keys(change ?? {})).toEqual(['key', 'previousValue', 'currentValue']);
  });

  it('reports a condition that appeared and one that went away', () => {
    const diff = diffRegulatoryVersions(
      version({ conditions: { maxConcentrationPercent: 2 } }),
      version({ id: 'v2', conditions: { minimumAgeYears: 3 } }),
    );
    const keys = diff.conditionsChanged.map((c) => c.key);
    expect(keys).toContain('maxConcentrationPercent');
    expect(keys).toContain('minimumAgeYears');
    expect(
      diff.conditionsChanged.find((c) => c.key === 'maxConcentrationPercent')?.currentValue,
    ).toBeNull();
  });

  it('treats a reordered list as a change rather than sorting both sides', () => {
    // A regulator's list of prohibited routes is not a set somebody may reorder, and a diff that
    // sorted both sides would report no change where a source had rewritten its own text.
    const diff = diffRegulatoryVersions(
      version({ conditions: { prohibitedRoutes: ['inhalation', 'oral'] } }),
      version({ id: 'v2', conditions: { prohibitedRoutes: ['oral', 'inhalation'] } }),
    );
    expect(diff.conditionsChanged.some((c) => c.key === 'prohibitedRoutes')).toBe(true);
  });

  it('treats an empty list and an absent one as the same absence', () => {
    const diff = diffRegulatoryVersions(
      version({ conditions: { productCategories: [] } }),
      version({ id: 'v2', conditions: {} }),
    );
    expect(diff.conditionsChanged.some((c) => c.key === 'productCategories')).toBe(false);
  });

  it('reports each scope change separately', () => {
    const diff = diffRegulatoryVersions(
      version(),
      version({
        id: 'v2',
        sourceRegistryEntryId: 's2',
        legalReference: 'Annex III, entry 2',
        publicationDate: calendarDate('2026-06-01'),
      }),
    );
    expect(diff.sourceChanged).toBe(true);
    expect(diff.legalReferenceChanged).toBe(true);
    expect(diff.publicationDateChanged).toBe(true);
    expect(diff.effectiveDateChanged).toBe(false);
  });

  it('reaches no verdict about the direction of a change', () => {
    const diff = diffRegulatoryVersions(
      version({ statuses: ['RESTRICTED'] }),
      version({ id: 'v2', statuses: ['PROHIBITED'] }),
    );
    // `09` forbids value judgements between jurisdictions, and between two versions of one rule
    // the same holds: whether a change matters depends on what the reader is doing.
    const keys = Object.keys(diff);
    for (const forbidden of ['stricter', 'severity', 'direction', 'worse', 'score']) {
      expect(keys).not.toContain(forbidden);
    }
    expect(JSON.stringify(diff).toLowerCase()).not.toContain('stricter');
  });
});

describe('whether what a person is asked to do changed', () => {
  it('is read from the two assessments, not derived from the rule diff', () => {
    // A regulator can narrow a concentration limit without altering what a household should do
    // about a pack they already own. The two questions are separate and are answered separately.
    const unchanged = diffUserAction({
      previousUrgency: 'MEDIUM',
      currentUrgency: 'MEDIUM',
      previousTemplateId: 'tpl.expiry',
      currentTemplateId: 'tpl.expiry',
    });
    expect(unchanged.changed).toBe(false);
    expect(unchanged.comparable).toBe(true);
  });

  it('reports an urgency change and a wording change separately', () => {
    const urgency = diffUserAction({
      previousUrgency: 'LOW',
      currentUrgency: 'HIGH',
      previousTemplateId: 'tpl.expiry',
      currentTemplateId: 'tpl.expiry',
    });
    expect(urgency.urgencyChanged).toBe(true);
    expect(urgency.wordingChanged).toBe(false);

    const wording = diffUserAction({
      previousUrgency: 'LOW',
      currentUrgency: 'LOW',
      previousTemplateId: 'tpl.expiry',
      currentTemplateId: 'tpl.batch',
    });
    expect(wording.wordingChanged).toBe(true);
    expect(wording.urgencyChanged).toBe(false);
  });

  it('says it cannot compare rather than reporting no change', () => {
    const view = diffUserAction({
      previousUrgency: null,
      currentUrgency: 'HIGH',
      previousTemplateId: 'tpl.expiry',
      currentTemplateId: 'tpl.expiry',
    });
    expect(view.comparable).toBe(false);
    expect(view.changed).toBe(false);
  });
});

describe('the shape the presentation layer declares', () => {
  it('accepts a real diff without a cast', () => {
    // `@kynviora/presentation` declares the diff structurally because the registry is not carried
    // in the Expo bundle. Structural mirrors drift; this is the pin.
    const diff: RegulatoryDiff = diffRegulatoryVersions(version(), version({ id: 'v2' }));
    const asInput: RegulatoryDiffInput = diff;
    expect(asInput.currentVersionId).toBe('v2');
  });

  it('gives every attribution a presentation', () => {
    for (const attribution of CHANGE_ATTRIBUTIONS) {
      const presentation = ATTRIBUTION_PRESENTATION[attribution];
      expect(presentation.label.length).toBeGreaterThan(0);
      expect(presentation.description.length).toBeGreaterThan(20);
    }
  });

  it('marks exactly one attribution as Kynviora being wrong', () => {
    const wrong = CHANGE_ATTRIBUTIONS.filter((a) => ATTRIBUTION_PRESENTATION[a].kynvioraWasWrong);
    expect(wrong).toEqual(['KYNVIORA_CORRECTED_ITSELF']);
  });

  it('renders the exit criterion as two different sentences', () => {
    const regulator = regulatoryDiffView({
      diff: diffRegulatoryVersions(version(), version({ id: 'v2', statuses: ['PROHIBITED'] })),
      attribution: 'REGULATOR_ACTED',
      action: { urgencyChanged: false, wordingChanged: false, changed: false, comparable: true },
    });
    const correction = regulatoryDiffView({
      diff: diffRegulatoryVersions(version(), version({ id: 'v2', statuses: ['PROHIBITED'] })),
      attribution: 'KYNVIORA_CORRECTED_ITSELF',
      action: { urgencyChanged: false, wordingChanged: false, changed: false, comparable: true },
    });

    expect(regulator.attribution.label).not.toBe(correction.attribution.label);
    expect(correction.attribution.description).toContain('Kynviora had something wrong');
    expect(regulator.attribution.description).toContain('right at the time');
  });

  it('says nobody recorded why, rather than guessing', () => {
    const view = regulatoryDiffView({
      diff: diffRegulatoryVersions(version(), version({ id: 'v2' })),
      attribution: 'NOT_STATED',
      action: { urgencyChanged: false, wordingChanged: false, changed: false, comparable: false },
    });
    expect(view.attribution.label).toContain('Nobody recorded');
    expect(view.actionNote).toContain('cannot compare');
  });

  it('drops a status it has no wording for and counts it', () => {
    const view = regulatoryDiffView({
      diff: {
        ...diffRegulatoryVersions(version(), version({ id: 'v2' })),
        statusesAdded: ['SOMETHING_NEW'],
        anyChange: true,
      },
      attribution: 'REGULATOR_ACTED',
      action: { urgencyChanged: false, wordingChanged: false, changed: false, comparable: true },
    });
    expect(view.statusesAdded).toEqual([]);
    expect(view.undescribedStatusCount).toBe(1);
    expect(JSON.stringify(view)).not.toContain('SOMETHING_NEW');
  });

  it('renders an absent condition value as words rather than as a blank', () => {
    const view = regulatoryDiffView({
      diff: diffRegulatoryVersions(
        version({ conditions: { maxConcentrationPercent: 2 } }),
        version({ id: 'v2', conditions: {} }),
      ),
      attribution: 'REGULATOR_ACTED',
      action: { urgencyChanged: false, wordingChanged: false, changed: false, comparable: true },
    });
    const change = view.conditionsChanged.find(
      (c) => c.label === 'Highest permitted concentration',
    );
    // A blank reads as "no condition". "not set" reads as what it is.
    expect(change?.currentValue).toBe('not set');
    expect(change?.previousValue).toBe('2');
  });

  it('says an unchanged pair is not a statement that nothing happened', () => {
    const view = regulatoryDiffView({
      diff: diffRegulatoryVersions(version(), version({ id: 'v2' })),
      attribution: 'NOT_STATED',
      action: { urgencyChanged: false, wordingChanged: false, changed: false, comparable: true },
    });
    expect(view.anyChange).toBe(false);
    expect(view.emptyMessage).toContain('not a statement that nothing happened');
  });

  it('carries a limitation saying what the comparison is not', () => {
    const view = regulatoryDiffView({
      diff: diffRegulatoryVersions(version(), version({ id: 'v2' })),
      attribution: 'REGULATOR_ACTED',
      action: { urgencyChanged: false, wordingChanged: false, changed: false, comparable: true },
    });
    expect(view.limitation).toContain('two versions of one rule');
  });
});
