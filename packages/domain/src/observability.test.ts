import { describe, it, expect } from 'vitest';
import * as observability from './observability.js';
import {
  METRIC_UNIT,
  METRIC_UNITS,
  OPERATIONAL_METRICS,
  metricsAsRecord,
  projectOperationalSnapshot,
  projectSourceHealth,
  type MetricKey,
  type OperationalCounts,
  type SourceHealthInput,
} from './observability.js';
import type { Instant } from './ports.js';

/**
 * `20` in one file.
 *
 * Two of its rules are the ones worth a test rather than a comment: operator output carries no
 * sensitive content, and nothing here reaches a verdict. The first is a property of the types and
 * is checked by walking a real snapshot; the second is an absence, and an absence only stays
 * absent if something fails when it is added.
 */

const NOW = '2026-09-01T12:00:00.000Z' as Instant;
const at = (iso: string) => iso as Instant;

const source = (over: Partial<SourceHealthInput> = {}): SourceHealthInput => ({
  sourceId: 's1',
  organization: 'Synthetic Authority',
  sourceName: 'Synthetic recall feed',
  jurisdiction: 'GB',
  status: 'APPROVED',
  parserVersion: 'v1',
  operationalOwner: 'ops@example.test',
  expectedRefreshIntervalMs: 24 * 60 * 60 * 1000,
  lastAttemptedCheckAt: at('2026-09-01T11:00:00.000Z'),
  lastSuccessfulCheckAt: at('2026-09-01T11:00:00.000Z'),
  lastNewRecordAt: at('2026-08-30T11:00:00.000Z'),
  consecutiveFailureCount: 0,
  ...over,
});

const counts = (over: Partial<OperationalCounts> = {}): OperationalCounts => ({
  reviewerQueueOpenRequests: 0,
  reviewerQueueOldestOpenAt: null,
  reviewerQueueAwaitingSecondApproval: 0,
  alertsPublished: 0,
  alertsWithdrawn: 0,
  assessmentCorrections: 0,
  shadowRunsRecorded: 0,
  extractionRunsSucceeded: 0,
  extractionRunsFailed: 0,
  extractionRunsAbstained: 0,
  catalogConflictsOpen: 0,
  reviewTasksOpen: 0,
  reviewTasksOldestOpenAt: null,
  publicationBlocked: false,
  sources: [],
  ...over,
});

describe('operator output carries no sensitive content', () => {
  it('has nowhere in a reading to put a name, an ID or a sentence', () => {
    // `20`: "measure system behavior, not sensitive content"; "alerts to operators should contain
    // identifiers/codes, not medicine names or diagnoses". The rule is kept by the type having
    // nowhere to express the violation.
    const snapshot = projectOperationalSnapshot(counts({ reviewTasksOpen: 3 }), NOW);
    for (const reading of snapshot.metrics) {
      expect(Object.keys(reading).sort()).toEqual(['key', 'unit', 'value']);
      expect(typeof reading.value).toBe('number');
      expect(OPERATIONAL_METRICS).toContain(reading.key);
      expect(METRIC_UNITS).toContain(reading.unit);
    }
  });

  it('cannot name which profile has the oldest review task', () => {
    // The queue age is a number. A projection that reported the subject would have handed an
    // operator a profile ID beside a health complaint, which is the disclosure `20` is about.
    const snapshot = projectOperationalSnapshot(
      counts({ reviewTasksOpen: 1, reviewTasksOldestOpenAt: at('2026-08-31T12:00:00.000Z') }),
      NOW,
    );
    const serialised = JSON.stringify(snapshot.metrics);
    expect(serialised).not.toMatch(/profile|user|medicine|item/i);
  });

  it('exports nothing that could attach a subject to a metric', () => {
    const names = Object.keys(observability);
    expect(names.filter((n) => /profile|user|patient|medicine|subject/i.test(n))).toEqual([]);
  });
});

describe('nothing here reaches a verdict', () => {
  it('carries no status, severity, score or threshold on a reading', () => {
    // `20` lists the alerting conditions and then says "exact thresholds must be documented
    // before production". None are, and `BLK-008` records that no labelled dataset exists to set
    // them against - so a DEGRADED here would be an invented answer an operator would act on.
    const snapshot = projectOperationalSnapshot(counts({ sources: [source()] }), NOW);
    const keys = new Set(snapshot.metrics.flatMap((reading) => Object.keys(reading)));
    for (const forbidden of ['status', 'severity', 'score', 'threshold', 'healthy', 'level']) {
      expect([...keys]).not.toContain(forbidden);
    }
  });

  it('gives a source row no health verdict either', () => {
    const [row] = projectOperationalSnapshot(counts({ sources: [source()] }), NOW).sources;
    expect(Object.keys(row ?? {})).toEqual(
      expect.not.arrayContaining(['severity', 'healthScore', 'degraded', 'critical', 'alertLevel']),
    );
  });

  it('exports no function that would classify one', () => {
    const names = Object.keys(observability);
    expect(names.filter((n) => /threshold|severity|classif|verdict|alertOn/i.test(n))).toEqual([]);
  });
});

describe('source freshness against the cadence the source itself declares', () => {
  it('reports how far past its own interval a source is', () => {
    // Not a threshold this module invents: `expected_refresh_interval_ms` is stored on the
    // registry row and was approved when the source was registered.
    const row = projectSourceHealth(
      source({ lastSuccessfulCheckAt: at('2026-08-30T12:00:00.000Z') }),
      NOW,
    );
    expect(row.overdueByMs).toBe(24 * 60 * 60 * 1000);
    expect(row.neverSucceeded).toBe(false);
  });

  it('reports a source inside its interval as not overdue', () => {
    expect(projectSourceHealth(source(), NOW).overdueByMs).toBeNull();
  });

  it('keeps "never checked" apart from "not overdue"', () => {
    // A source that has never succeeded is not zero milliseconds overdue. Reporting it as such
    // hides the worst case inside the best-looking number.
    const row = projectSourceHealth(source({ lastSuccessfulCheckAt: null }), NOW);
    expect(row.neverSucceeded).toBe(true);
    expect(row.overdueByMs).toBeNull();
  });

  it('counts the two separately in the snapshot', () => {
    const snapshot = projectOperationalSnapshot(
      counts({
        sources: [
          source({ sourceId: 'fresh' }),
          source({ sourceId: 'late', lastSuccessfulCheckAt: at('2026-08-01T12:00:00.000Z') }),
          source({ sourceId: 'never', lastSuccessfulCheckAt: null }),
        ],
      }),
      NOW,
    );
    const values = metricsAsRecord(snapshot);
    expect(values.sources_registered).toBe(3);
    expect(values.sources_overdue).toBe(1);
    expect(values.sources_never_successfully_checked).toBe(1);
  });

  it('names an unowned source as an operational finding', () => {
    // `20`: "do not create alerts no one owns", and the Source Health Dashboard requires an
    // operational owner. A finding this projection can make with no threshold at all.
    expect(projectSourceHealth(source({ operationalOwner: null }), NOW).unowned).toBe(true);
    expect(projectSourceHealth(source({ operationalOwner: '   ' }), NOW).unowned).toBe(true);
    expect(projectSourceHealth(source(), NOW).unowned).toBe(false);
  });

  it('counts consecutive failures without deciding what they mean', () => {
    const snapshot = projectOperationalSnapshot(
      counts({ sources: [source({ consecutiveFailureCount: 4 }), source({ sourceId: 's2' })] }),
      NOW,
    );
    expect(metricsAsRecord(snapshot).sources_with_consecutive_failures).toBe(1);
  });
});

describe('the queues', () => {
  it('keeps the reviewer queue and the household inbox apart', () => {
    // Two different queues. Conflating them reports staff workload as user workload, or the
    // reverse, and only one of them is a safety metric in `20`'s sense.
    const snapshot = projectOperationalSnapshot(
      counts({
        reviewerQueueOpenRequests: 2,
        reviewerQueueOldestOpenAt: at('2026-08-31T12:00:00.000Z'),
        reviewTasksOpen: 9,
        reviewTasksOldestOpenAt: at('2026-08-25T12:00:00.000Z'),
      }),
      NOW,
    );
    const values = metricsAsRecord(snapshot);
    expect(values.reviewer_queue_open_requests).toBe(2);
    expect(values.reviewer_queue_oldest_open_age_ms).toBe(24 * 60 * 60 * 1000);
    expect(values.review_tasks_open).toBe(9);
    expect(values.review_tasks_oldest_open_age_ms).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('reports an empty queue as an age of zero rather than omitting it', () => {
    const values = metricsAsRecord(projectOperationalSnapshot(counts(), NOW));
    expect(values.reviewer_queue_oldest_open_age_ms).toBe(0);
    expect(values.review_tasks_oldest_open_age_ms).toBe(0);
  });

  it('never reports a negative age', () => {
    // A row timestamped slightly ahead of the snapshot clock is a clock-skew artefact, not a
    // queue that will be filled in the future.
    const values = metricsAsRecord(
      projectOperationalSnapshot(
        counts({ reviewTasksOldestOpenAt: at('2026-09-01T12:00:05.000Z') }),
        NOW,
      ),
    );
    expect(values.review_tasks_oldest_open_age_ms).toBe(0);
  });
});

describe('the snapshot as a whole', () => {
  it('reports every metric on every snapshot, including the zeroes', () => {
    // A dashboard that only receives a metric when it is non-zero cannot tell "nothing happened"
    // from "the projection stopped running", and `20` treats a silent failure of the
    // observability path as an incident of its own.
    const snapshot = projectOperationalSnapshot(counts(), NOW);
    expect(snapshot.metrics.map((m) => m.key)).toEqual([...OPERATIONAL_METRICS]);
    for (const reading of snapshot.metrics) expect(reading.value).toBe(0);
  });

  it('states a unit for every metric', () => {
    // A new key fails to compile without one, and this asserts the record has not drifted.
    for (const key of OPERATIONAL_METRICS as readonly MetricKey[]) {
      expect(METRIC_UNITS).toContain(METRIC_UNIT[key]);
    }
    expect(Object.keys(METRIC_UNIT).sort()).toEqual([...OPERATIONAL_METRICS].sort());
  });

  it('reports the publication block as a number, because a metric stream carries numbers', () => {
    expect(metricsAsRecord(projectOperationalSnapshot(counts(), NOW)).publication_blocked).toBe(0);
    expect(
      metricsAsRecord(projectOperationalSnapshot(counts({ publicationBlocked: true }), NOW))
        .publication_blocked,
    ).toBe(1);
    expect(METRIC_UNIT.publication_blocked).toBe('BOOLEAN');
  });

  it('carries the clock it was given, so a snapshot is replayable', () => {
    // Not an authorization predicate - nothing is granted or refused on the answer - so the
    // injected clock is correct here and DEC-024's real-clock rule does not apply.
    expect(projectOperationalSnapshot(counts(), NOW).at).toBe(NOW);
  });

  it('flattens to a record a collector can scrape', () => {
    const snapshot = projectOperationalSnapshot(counts({ alertsPublished: 4 }), NOW);
    const record = metricsAsRecord(snapshot);
    expect(Object.keys(record).sort()).toEqual([...OPERATIONAL_METRICS].sort());
    expect(record.alerts_published).toBe(4);
  });
});
