/**
 * What the Health pieces say, and what they must never say.
 *
 * Spec references: `09`/`10` (a source fact and a Kynviora conclusion are different things), `02`
 * (no score, no ranking, no all-clear), `18` (never colour alone; an absence is legible as an
 * absence), DEC-153, DEC-155.
 *
 * WHY THIS EXISTS BESIDE THE API TESTS
 * The API tests prove the server never sends a verdict. This proves the screen never renders one -
 * which is a different failure, and the likelier one: a component given `outsideReportedInterval`
 * could perfectly reasonably print "High" beside it, and every server test would still pass.
 *
 * WHY IT IS NOT UNDER `src/app`
 * Trap 201: `src/app` is Expo Router's route directory, enumerated with `require.context`, so a
 * `.test.tsx` there is bundled into the app, imports `react-test-renderer`, and the phone shows
 * Metro's red overlay with nothing running.
 */

import { describe, it, expect } from 'vitest';
import {
  healthObservationView,
  healthRecordLineView,
  healthSourceView,
  healthTrendView,
  type HealthObservationResponse,
  type HealthRecordResponse,
  type HealthSourceResponse,
} from '@kynviora/contracts';
import { classifyChange } from '@kynviora/domain';
import { allNodes, accessibleNameOf, renderScreen, textOf } from '../../../test/render.js';
import { ChangeSection, ObservationRow, RecordRow, SourceRow, TrendCard } from './HealthPieces';

/** Every word rendered anywhere under a render, joined. */
function screenText(rendered: ReturnType<typeof renderScreen>): string {
  return allNodes(rendered)
    .map((node) => textOf(node))
    .join(' ');
}

const OBSERVATION: HealthObservationResponse = {
  id: 'obs-1',
  analyteCode: 'tsh',
  displayName: 'TSH',
  sequence: 0,
  valueNumeric: 5.2,
  valueText: null,
  unit: 'mIU/L',
  decimals: 1,
  reference: { low: 0.4, high: 4.0, text: null },
  referenceComparison: 'OUTSIDE_ABOVE',
  sourceFlag: 'HIGH',
};

/**
 * The words a lab screen must never render about a person.
 *
 * Written out rather than derived, for the reason `SafetyRow.test.tsx` writes its sentences out:
 * a test that imported the copy would pass on any wording the app happened to be shipping.
 */
const FORBIDDEN = [
  'abnormal',
  'normal range',
  'is high',
  'is low',
  'concerning',
  'healthy',
  'unhealthy',
  'all clear',
  'looks good',
  'no problems',
];

describe('a lab result on screen', () => {
  it('renders the value, the report’s range and the report’s flag', () => {
    const rendered = renderScreen(
      <ObservationRow observation={healthObservationView(OBSERVATION)} />,
    );
    const text = screenText(rendered);
    expect(text).toContain('TSH');
    expect(text).toContain('5.2 mIU/L');
    expect(text).toContain('0.4 – 4.0 mIU/L');
    rendered.unmount();
  });

  it('names the report as the author of every judgement-shaped sentence', () => {
    // DEC-155's whole claim at the last surface it could be broken on. "Above the range this
    // report gave" and "High" are different statements, and only the first is one Kynviora is
    // entitled to make.
    const rendered = renderScreen(
      <ObservationRow observation={healthObservationView(OBSERVATION)} />,
    );
    const text = screenText(rendered);
    expect(text).toContain('Above the range this report gave');
    expect(text).toContain('Kynviora adds no interpretation');
    expect(text).toContain('Flagged high by the source report');
    rendered.unmount();
  });

  it('renders no word that states a verdict about the person', () => {
    const rendered = renderScreen(
      <ObservationRow observation={healthObservationView(OBSERVATION)} />,
    );
    const text = screenText(rendered).toLowerCase();
    for (const word of FORBIDDEN) {
      expect(text, word).not.toContain(word);
    }
    rendered.unmount();
  });

  it('says plainly when the report gave no range, rather than leaving a blank', () => {
    // A blank where a range belongs reads as no range being needed, which is the opposite of what
    // it means. `18`: an absence has to be legible as an absence.
    const rendered = renderScreen(
      <ObservationRow
        observation={healthObservationView({
          ...OBSERVATION,
          reference: null,
          referenceComparison: 'NO_INTERVAL',
          sourceFlag: null,
        })}
      />,
    );
    const text = screenText(rendered);
    expect(text).toContain('This report gave no range.');
    // And no reassurance in its place.
    expect(text.toLowerCase()).not.toContain('fine');
    rendered.unmount();
  });

  it('prints a text result as the report wrote it', () => {
    const rendered = renderScreen(
      <ObservationRow
        observation={healthObservationView({
          ...OBSERVATION,
          analyteCode: 'hbsag',
          displayName: 'HBsAg',
          valueNumeric: null,
          valueText: 'Not detected',
          unit: null,
          reference: { low: null, high: null, text: 'Not detected' },
          referenceComparison: 'NOT_COMPARABLE',
          sourceFlag: null,
        })}
      />,
    );
    expect(screenText(rendered)).toContain('Not detected');
    rendered.unmount();
  });

  it('announces the conclusion before the numbers', () => {
    const view = healthObservationView(OBSERVATION);
    expect(view.accessibilityLabel).toMatch(/^TSH\. 5\.2 mIU\/L\./);
    expect(view.accessibilityLabel).toContain('Above the range this report gave');
    expect(view.accessibilityLabel).toContain('source report');
  });

  it('prints a quoted number at exactly the precision the report used', () => {
    // The report's own precision, both ways. A lab that printed two places gets two back, and one
    // that printed `4.0` as a bound is not misquoted as `4`. This is the opposite rule from the
    // one a *delta* follows, and deliberately: a quotation carries the source's precision, an
    // arithmetic result carries none of its own.
    expect(healthObservationView({ ...OBSERVATION, decimals: 2 }).valueText).toBe('5.20 mIU/L');
    expect(healthObservationView({ ...OBSERVATION, decimals: 0 }).valueText).toBe('5 mIU/L');
    expect(healthObservationView(OBSERVATION).referenceText).toBe('0.4 – 4.0 mIU/L');
  });
});

describe('a record row', () => {
  const RECORD: HealthRecordResponse = {
    id: 'rec-1',
    profileId: 'p-1',
    kind: 'LAB_REPORT',
    title: 'Thyroid panel',
    providerName: 'A lab (synthetic)',
    recordedOn: '2026-09-02',
    sourceId: null,
    hasDocument: false,
    extractionState: 'EXTRACTED_UNCONFIRMED',
    provenance: 'IMPORTED',
    note: null,
    version: 1,
    updatedAt: null,
    observationCount: 3,
    sourceFlaggedCount: 1,
  };

  it('always says how the record got here, including when nobody has checked it', () => {
    // `04` Phase 1.3. A sentence that appears only sometimes is one a person learns to stop
    // looking for, so it is rendered unconditionally.
    const rendered = renderScreen(
      <RecordRow record={healthRecordLineView(RECORD)} onOpen={() => {}} />,
    );
    expect(screenText(rendered)).toContain('Read from the document and not yet checked by anyone.');
    rendered.unmount();
  });

  it('attributes the flag count to the report', () => {
    const rendered = renderScreen(
      <RecordRow record={healthRecordLineView(RECORD)} onOpen={() => {}} />,
    );
    const text = screenText(rendered);
    expect(text).toContain('1 flagged by the report');
    expect(text.toLowerCase()).not.toContain('abnormal');
    rendered.unmount();
  });

  it('says a date is missing rather than showing nothing where one belongs', () => {
    const rendered = renderScreen(
      <RecordRow
        record={healthRecordLineView({ ...RECORD, recordedOn: null })}
        onOpen={() => {}}
      />,
    );
    expect(screenText(rendered)).toContain('No date recorded');
    rendered.unmount();
  });

  it('carries an accessible name a screen reader can act on', () => {
    const rendered = renderScreen(
      <RecordRow record={healthRecordLineView(RECORD)} onOpen={() => {}} />,
    );
    const named = allNodes(rendered).filter((node) =>
      accessibleNameOf(node).startsWith('Lab report. Thyroid panel.'),
    );
    expect(named.length).toBeGreaterThan(0);
    rendered.unmount();
  });

  it('renders a record whose kind this build does not know rather than hiding it', () => {
    // Hiding somebody's record because a client is out of date is worse than showing it without
    // a category.
    const view = healthRecordLineView({ ...RECORD, kind: 'GENOMIC_PANEL' });
    expect(view.kind).toBeNull();
    expect(view.kindLabel).toBe('Record');
    const rendered = renderScreen(<RecordRow record={view} onOpen={() => {}} />);
    expect(screenText(rendered)).toContain('Thyroid panel');
    rendered.unmount();
  });
});

describe('a source row', () => {
  const SOURCE: HealthSourceResponse = {
    id: 'src-1',
    sourceKind: 'HEALTH_KIT',
    displayName: 'Apple Health',
    connectionState: 'DESIGNED_NOT_IMPLEMENTED',
    lastReceivedAt: null,
  };

  it('says an unbuilt integration is unbuilt rather than inviting a connection', () => {
    // `21` of the V3 brief, by name: do not visually imply a real integration that has not been
    // implemented.
    const rendered = renderScreen(<SourceRow source={healthSourceView(SOURCE)} />);
    const text = screenText(rendered);
    expect(text).toContain('Designed, not built');
    expect(text).toContain('has not built it');
    expect(text.toLowerCase()).not.toContain('connect now');
    rendered.unmount();
  });

  it('distinguishes an import from a connection in words, not only in colour', () => {
    const imported = healthSourceView({
      ...SOURCE,
      connectionState: 'IMPORTED_ONCE',
      lastReceivedAt: '2026-08-01T00:00:00.000Z',
    });
    expect(imported.stateLabel).toBe('Imported once');
    expect(imported.stateSentence).toContain('not a live connection');
    expect(imported.isLive).toBe(false);
  });

  it('treats an unrecognised state as not live', () => {
    // Anything else would render an unknown as a connection, which is the one direction that
    // makes a promise the app cannot keep.
    const unknown = healthSourceView({ ...SOURCE, connectionState: 'SYNCING_MAYBE' });
    expect(unknown.isLive).toBe(false);
    expect(unknown.stateSentence).toContain('does not recognise');
  });
});

describe('a trend', () => {
  const point = (id: string, at: string, value: number, secondary: number | null = null) => ({
    id,
    metric: 'BLOOD_PRESSURE',
    measuredAt: at,
    value,
    secondary,
    unit: 'mmHg',
    sourceId: null,
    deviceName: 'Home monitor',
  });

  it('draws a paired reading as one bar and names both numbers', () => {
    const trend = healthTrendView('BLOOD_PRESSURE', [
      point('m1', '2026-09-05T08:00:00.000Z', 128, 82),
      point('m2', '2026-09-07T08:00:00.000Z', 132, 84),
    ]);
    expect(trend.latestText).toBe('132/84 mmHg');
    const rendered = renderScreen(<TrendCard trend={trend} />);
    expect(screenText(rendered)).toContain('132/84 mmHg');
    rendered.unmount();
  });

  it('refuses to connect points for a metric that is not sampled continuously', () => {
    // A connecting line asserts the quantity took the intermediate values. Between two blood
    // pressures two days apart, nobody measured whether it did.
    expect(healthTrendView('BLOOD_PRESSURE', []).connectPoints).toBe(false);
    expect(healthTrendView('RESTING_HEART_RATE', []).connectPoints).toBe(true);
  });

  it('states a gap in words as well as drawing one', () => {
    const trend = healthTrendView('BLOOD_PRESSURE', [
      point('m1', '2026-08-01T08:00:00.000Z', 128, 82),
      point('m2', '2026-09-07T08:00:00.000Z', 132, 84),
    ]);
    expect(trend.largestGapDays).toBe(37);
    const rendered = renderScreen(<TrendCard trend={trend} />);
    expect(screenText(rendered)).toContain('longest gap 37 days, shown as a gap');
    rendered.unmount();
  });

  it('says nothing has been recorded rather than drawing an empty chart', () => {
    const rendered = renderScreen(<TrendCard trend={healthTrendView('BODY_WEIGHT', [])} />);
    expect(screenText(rendered)).toContain('Nothing has been recorded for this yet.');
    rendered.unmount();
  });
});

describe('a change section', () => {
  const entry = classifyChange(
    {
      key: 'tsh',
      label: 'TSH',
      current: { value: 5.2, unit: 'mIU/L' },
      previous: { value: 4.8, unit: 'mIU/L' },
    },
    'REPEAT',
  );

  it('shows what moved, against what, and by how much', () => {
    const rendered = renderScreen(
      <ChangeSection classification="CHANGED" entries={[entry]} expanded onToggle={() => {}} />,
    );
    const text = screenText(rendered);
    expect(text).toContain('Changed · 1');
    expect(text).toContain('4.8 mIU/L → 5.2 mIU/L');
    expect(text).toContain('▲ +0.4');
    rendered.unmount();
  });

  it('says "not repeated" rather than asserting a reason nobody knows', () => {
    const dropped = classifyChange(
      { key: 'b12', label: 'Vitamin B12', current: null, previous: { value: 410, unit: 'pg/mL' } },
      'PERIODIC',
    );
    const rendered = renderScreen(
      <ChangeSection
        classification="NOT_REPEATED"
        entries={[dropped]}
        expanded
        onToggle={() => {}}
      />,
    );
    const text = screenText(rendered);
    expect(text).toContain('Not repeated');
    expect(text).toContain('Kynviora does not know why');
    expect(text.toLowerCase()).not.toContain('removed');
    rendered.unmount();
  });

  it('renders nothing at all for an empty section rather than an empty card', () => {
    const rendered = renderScreen(
      <ChangeSection classification="NEW" entries={[]} expanded onToggle={() => {}} />,
    );
    expect(screenText(rendered).trim()).toBe('');
    rendered.unmount();
  });

  it('keeps the count on the header when the rows are collapsed', () => {
    // The whole point of collapsing `Similar`: a person sees that thirty-four results did not
    // move without scrolling past thirty-four rows.
    const rendered = renderScreen(
      <ChangeSection
        classification="SIMILAR"
        entries={[entry, entry]}
        expanded={false}
        onToggle={() => {}}
      />,
    );
    const text = screenText(rendered);
    expect(text).toContain('Similar · 2');
    expect(text).not.toContain('4.8 mIU/L → 5.2 mIU/L');
    rendered.unmount();
  });

  it('says why a pair carries no number instead of leaving it blank', () => {
    const converted = classifyChange(
      {
        key: 'crp',
        label: 'CRP',
        current: { value: 0.9, unit: 'mg/dL' },
        previous: { value: 9, unit: 'mg/L' },
      },
      'PERIODIC',
    );
    const rendered = renderScreen(
      <ChangeSection classification="CHANGED" entries={[converted]} expanded onToggle={() => {}} />,
    );
    expect(screenText(rendered)).toContain('The unit changed');
    rendered.unmount();
  });
});
