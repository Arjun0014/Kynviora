/**
 * Health screen.
 *
 * Spec references: `06` (amended by DEC-151 - Health is a primary destination and Safety is a lens
 * with an address), `09`/`10` (a source fact and a Kynviora conclusion are different things), `02`
 * (no score, no grade, no ranking), `18` (an absence is legible as an absence; one heading per
 * screen; nothing carried by colour alone), DEC-138, DEC-153, DEC-154, DEC-155.
 *
 * WHAT THIS SCREEN ANSWERS
 * V3 states it in one sentence: *what does Kynviora actually know about this person, where did it
 * come from, what changed, and how has it evolved over time*. Four layers, because those are four
 * questions and one scroll holding all of them puts a lab value from last year under a heart rate
 * from this morning.
 *
 * WHY THE COVERAGE STATEMENT IS FIRST, HERE TOO
 * DEC-138's reasoning transfers exactly. A Health screen with three records on it invites the
 * conclusion that three records is all there is to know, and a qualification arriving underneath
 * arrives after the reading it was meant to qualify. So `HEALTH_COVERAGE_STATEMENT` is a card, in
 * `informational`, above the content, in every state.
 *
 * THERE IS NO HEALTH SCORE AND NO CODE PATH THAT COULD PRODUCE ONE
 * `02` forbids it and the V3 brief repeats the ban twice. Nothing on this screen aggregates
 * anything: the counts are counts of records and readings, the comparison counts come from the
 * server's Change Lens, and the only judgement-shaped words on screen are quotations attributed to
 * a report.
 *
 * NOTHING HERE IS FABRICATED WHEN A SOURCE DOES NOT EXIST
 * The Trends layer renders whatever measurements have actually been recorded. A profile with no
 * measurements gets a sentence saying so and no chart - not an empty axis, and not a demo curve.
 * The Sources block says `Designed, not built` for Health Connect and HealthKit, because that is
 * what they are (`21` of the brief).
 */

import { useCallback, useMemo, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { SPACING, type Theme } from '@kynviora/presentation';
import { HEALTH_METRICS, type HealthMetric } from '@kynviora/domain';
import {
  HEALTH_COVERAGE_STATEMENT,
  healthComparisonView,
  healthObservationView,
  healthRecordLineView,
  healthSourceView,
  healthTimelineEntryView,
  healthTrendView,
  type HealthMeasurementResponse,
} from '@kynviora/contracts';
import { useApi } from '@/api/ApiProvider';
import { useProfiles } from '@/api/ProfileProvider';
import { useResource } from '@/api/useResource';
import { Card } from '@/components/Card';
import { Screen } from '@/components/Screen';
import { SectionHeader } from '@/components/SectionHeader';
import { ResourceState } from '@/components/ScreenState';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Typography } from '@/components/Typography';
import { useThemedStyles } from '@/theme/ThemeProvider';
import { TalkBar } from '@/voice/TalkBar';
import { useDeclareScreen, type ScreenActionBinding } from '@/voice/ScreenContextProvider';
import {
  ChangeSection,
  HealthLayerPicker,
  ObservationRow,
  RecordRow,
  SourceRow,
  TimelineRow,
  TrendCard,
  type HealthLayer,
} from '@/features/health/HealthPieces';

const NO_RECORDS = { records: [] } as const;
const NO_SOURCES = { sources: [] } as const;
const NO_MEASUREMENTS = { measurements: [] } as const;
const NO_ENTRIES = { entries: [] } as const;

/**
 * The metrics a trend list offers, in the order it offers them.
 *
 * Every metric the schema knows, so a reading of any kind that has been recorded appears - and
 * one that has not says it has not, rather than being missing. A list narrowed to "the interesting
 * ones" is a ranking, and `02` refuses one.
 */
const TREND_ORDER: readonly HealthMetric[] = HEALTH_METRICS;

export default function HealthScreen() {
  const styles = useThemedStyles(makeStyles);
  const { client } = useApi();
  const { activeProfile, activeProfileId } = useProfiles();

  const [layer, setLayer] = useState<HealthLayer>('PROFILE');
  /** The record whose detail is open, or `null`. Reached from a row, like the Lens is. */
  const [openRecordId, setOpenRecordId] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [expandedSections, setExpandedSections] = useState<readonly string[]>([]);

  const loadRecords = useMemo(
    () =>
      client === null || activeProfileId === null
        ? null
        : () => client.healthRecords(activeProfileId),
    [client, activeProfileId],
  );
  const {
    resource: records,
    reload: reloadRecords,
    refreshing,
  } = useResource(loadRecords, {
    enabled: activeProfileId !== null,
    isEmpty: (value) => value.records.length === 0,
    // Spread rather than assigned, because `exactOptionalPropertyTypes` distinguishes an absent
    // key from one set to `undefined` - and the distinction is the right one here: a read with no
    // profile must not name a projection row at all.
    ...(activeProfileId === null ? {} : { projectionKey: `health-records:${activeProfileId}` }),
  });

  const loadSources = useMemo(
    () =>
      client === null || activeProfileId === null
        ? null
        : () => client.healthSources(activeProfileId),
    [client, activeProfileId],
  );
  const { resource: sources } = useResource(loadSources, {
    enabled: activeProfileId !== null,
    ...(activeProfileId === null ? {} : { projectionKey: `health-sources:${activeProfileId}` }),
  });

  const loadMeasurements = useMemo(
    () =>
      client === null || activeProfileId === null
        ? null
        : () => client.healthMeasurements(activeProfileId),
    [client, activeProfileId],
  );
  const { resource: measurements } = useResource(loadMeasurements, {
    enabled: activeProfileId !== null,
    ...(activeProfileId === null
      ? {}
      : { projectionKey: `health-measurements:${activeProfileId}` }),
  });

  const loadTimeline = useMemo(
    () =>
      client === null || activeProfileId === null || layer !== 'HISTORY'
        ? null
        : () => client.healthTimeline(activeProfileId),
    [client, activeProfileId, layer],
  );
  const { resource: timeline } = useResource(loadTimeline, {
    enabled: activeProfileId !== null && layer === 'HISTORY',
  });

  const loadRecord = useMemo(
    () =>
      client === null || openRecordId === null ? null : () => client.healthRecord(openRecordId),
    [client, openRecordId],
  );
  const { resource: recordDetail } = useResource(loadRecord, { enabled: openRecordId !== null });

  const loadComparison = useMemo(
    () =>
      client === null || openRecordId === null || !comparing
        ? null
        : () => client.healthRecordComparison(openRecordId),
    [client, openRecordId, comparing],
  );
  const { resource: comparison } = useResource(loadComparison, {
    enabled: openRecordId !== null && comparing,
  });

  const recordLines = useMemo(
    () => (records.value ?? NO_RECORDS).records.map(healthRecordLineView),
    [records.value],
  );
  const sourceLines = useMemo(
    () => (sources.value ?? NO_SOURCES).sources.map(healthSourceView),
    [sources.value],
  );

  /**
   * Every metric that has at least one reading, in the schema's order.
   *
   * Grouped here rather than by one request per metric: eleven requests to draw one screen is a
   * cold start nobody waits through, and the server already returns them ordered by time.
   */
  const trends = useMemo(() => {
    const all: readonly HealthMeasurementResponse[] = (measurements.value ?? NO_MEASUREMENTS)
      .measurements;
    return TREND_ORDER.map((metric) =>
      healthTrendView(
        metric,
        all.filter((m) => m.metric === metric),
      ),
    ).filter((trend) => trend.points.length > 0);
  }, [measurements.value]);

  const timelineEntries = useMemo(
    () => (timeline.value ?? NO_ENTRIES).entries.map(healthTimelineEntryView),
    [timeline.value],
  );

  const detail = recordDetail.value;
  const comparisonView = useMemo(
    () => (comparison.value === null ? null : healthComparisonView(comparison.value)),
    [comparison.value],
  );

  /**
   * What Kynviora can do on this screen (DEC-157).
   *
   * The four layers, and nothing else. Each action is a change to this screen's own state and is
   * performed by this screen's own handler; the agent learns the names and the labels and never
   * the contents. "Open my latest lab report" is deliberately **not** here - it would need a
   * record id, which is data, and the way to reach a report is the row that names it.
   *
   * Memoised, because `useDeclareScreen` re-declares whenever this object changes and a fresh
   * array every render is the `exhaustive-deps` failure `DEV-044` and `DEV-045` were.
   */
  const screenActions = useMemo<readonly ScreenActionBinding[]>(
    () => [
      {
        id: 'health.profile',
        label: 'Show the health profile',
        says: 'Showing the health profile.',
        run: () => {
          setLayer('PROFILE');
        },
      },
      {
        id: 'health.records',
        label: 'Show my records',
        says: 'Showing records.',
        run: () => {
          setLayer('RECORDS');
        },
      },
      {
        id: 'health.trends',
        label: 'Show my measurements',
        says: 'Showing measurements.',
        run: () => {
          setLayer('TRENDS');
        },
      },
      {
        id: 'health.history',
        label: 'Show the health timeline',
        says: 'Showing the health timeline.',
        run: () => {
          setLayer('HISTORY');
        },
      },
    ],
    [],
  );

  useDeclareScreen(
    useMemo(
      () => ({
        route: 'HEALTH' as const,
        profileId: activeProfileId,
        // The record being read, as an identifier. Never its title.
        focusId: openRecordId,
        actions: screenActions,
      }),
      [activeProfileId, openRecordId, screenActions],
    ),
  );

  const closeRecord = useCallback(() => {
    setOpenRecordId(null);
    setComparing(false);
    setExpandedSections([]);
  }, []);

  const toggleSection = useCallback((name: string) => {
    setExpandedSections((current) =>
      current.includes(name) ? current.filter((n) => n !== name) : [...current, name],
    );
  }, []);

  // -------------------------------------------------------------------------
  // One record, open
  // -------------------------------------------------------------------------
  if (openRecordId !== null) {
    const line = detail === null ? null : healthRecordLineView(detail.record);
    return (
      <>
        <Screen
          title={line?.title ?? 'Record'}
          eyebrow={activeProfile?.displayName ?? null}
          {...(line === null ? {} : { intro: line.provenanceSentence })}
        >
          <PrimaryButton label="Back to Health" onPress={closeRecord} variant="secondary" />
          <ResourceState resource={recordDetail} />

          {detail === null ? null : (
            <>
              <Card>
                <Typography role="overline" colour="secondary" decorative>
                  {line?.kindLabel ?? 'Record'}
                </Typography>
                <Typography role="body" colour="secondary">
                  {[detail.record.providerName, detail.record.recordedOn ?? 'No date recorded']
                    .filter((part): part is string => part !== null)
                    .join(' · ')}
                </Typography>
                {/*
                  The one sentence a lab screen must never be without. `10` does not let Kynviora
                  turn a number into a conclusion, and a screen full of values with a range beside
                  each invites exactly that reading unless something says otherwise.
                */}
                <Typography role="caption" colour="secondary">
                  Ranges and flags on this page are what the report itself printed. Kynviora adds no
                  interpretation and does not say whether a value is normal.
                </Typography>
              </Card>

              {detail.observations.length === 0 ? (
                <Card>
                  <Typography role="body">
                    This record has no structured results. The document itself is what was kept.
                  </Typography>
                </Card>
              ) : (
                <Card>
                  <SectionHeader
                    title="Results"
                    explanation="In the order the report gives them."
                  />
                  {detail.observations.map((observation) => (
                    <ObservationRow
                      key={observation.id}
                      observation={healthObservationView(observation)}
                    />
                  ))}
                </Card>
              )}

              {detail.observations.length === 0 ? null : (
                <PrimaryButton
                  label={comparing ? 'Hide the comparison' : 'Compare with the record before this'}
                  onPress={() => setComparing((on) => !on)}
                  variant="secondary"
                />
              )}

              {comparing ? (
                <>
                  <ResourceState resource={comparison} />
                  {comparisonView === null ? null : comparisonView.unavailableReason !== null ? (
                    <Card tone="informational">
                      <Typography role="body" colour="informational">
                        {comparisonView.unavailableReason}
                      </Typography>
                    </Card>
                  ) : (
                    <>
                      <Card tone="change">
                        <Typography role="label" decorative>
                          {`Against ${comparisonView.previousTitle ?? 'the earlier record'}`}
                        </Typography>
                        <Typography role="body">
                          {`${comparisonView.comparedCount} ${comparisonView.comparedCount === 1 ? 'result' : 'results'} measured in both records.`}
                        </Typography>
                        {/*
                          The rule, printed from the same constant the counts were computed from,
                          so the sentence and the arithmetic cannot disagree (DEC-153).
                        */}
                        <Typography role="caption" colour="secondary">
                          {comparisonView.thresholdStatement}
                        </Typography>
                        <Typography role="caption" colour="secondary">
                          These counts describe the difference between two records. They are not a
                          judgement about health.
                        </Typography>
                        {comparisonView.incomparableCount > 0 ? (
                          <Typography role="caption" colour="secondary">
                            {`${comparisonView.incomparableCount} of them could not be compared as numbers. Each says why.`}
                          </Typography>
                        ) : null}
                      </Card>

                      {(['CHANGED', 'NEW', 'NOT_REPEATED', 'SIMILAR'] as const).map(
                        (classification) => (
                          <ChangeSection
                            key={classification}
                            classification={classification}
                            entries={comparisonView.entries.filter(
                              (entry) => entry.classification === classification,
                            )}
                            expanded={
                              classification === 'SIMILAR'
                                ? expandedSections.includes(classification)
                                : !expandedSections.includes(classification)
                            }
                            onToggle={() => toggleSection(classification)}
                          />
                        ),
                      )}
                    </>
                  )}
                </>
              ) : null}
            </>
          )}
        </Screen>
      </>
    );
  }

  // -------------------------------------------------------------------------
  // The four layers
  // -------------------------------------------------------------------------
  return (
    <>
      <Screen
        title="Health"
        eyebrow={activeProfile?.displayName ?? null}
        intro="What has been recorded about this person, where it came from, and what changed."
        onRefresh={reloadRecords}
        refreshing={refreshing}
        footer={<TalkBar />}
      >
        {/*
          First, at the same rank as the content, in every state (DEC-138). A Health screen with
          three records on it and no statement invites the reading that three records is the whole
          of what there is to know.
        */}
        <Card tone="informational">
          <Typography role="label" colour="informational" heading>
            What Health holds
          </Typography>
          <Typography role="body" colour="informational">
            {HEALTH_COVERAGE_STATEMENT}
          </Typography>
        </Card>

        <HealthLayerPicker layer={layer} onChange={setLayer} />

        {layer === 'PROFILE' ? (
          <View style={styles.stack}>
            <ResourceState resource={records} onRetry={reloadRecords} />

            <Card>
              <SectionHeader
                title="Latest measurements"
                explanation="Readings that have actually been recorded."
              />
              {trends.length === 0 ? (
                <Typography role="body" colour="secondary">
                  No measurements have been recorded for this person. Nothing arrives here on its
                  own.
                </Typography>
              ) : (
                trends.slice(0, 3).map((trend) => (
                  <View key={trend.label} style={styles.metricRow}>
                    <Typography role="body" decorative>
                      {trend.label}
                    </Typography>
                    <Typography role="label" decorative>
                      {trend.latestText ?? '—'}
                    </Typography>
                  </View>
                ))
              )}
            </Card>

            <Card>
              <SectionHeader
                title="Recent records"
                explanation="The most recent first, with where each came from."
              />
              {recordLines.length === 0 ? (
                <Typography role="body" colour="secondary">
                  No records have been added yet.
                </Typography>
              ) : (
                <Typography role="body" colour="secondary">
                  {`${recordLines.length} ${recordLines.length === 1 ? 'record' : 'records'} on file.`}
                </Typography>
              )}
            </Card>
            {recordLines.slice(0, 3).map((record) => (
              <RecordRow
                key={record.id}
                record={record}
                onOpen={() => setOpenRecordId(record.id)}
              />
            ))}

            <Card>
              <SectionHeader
                title="Where health data comes from"
                explanation="Each source says what it actually is."
              />
              {sourceLines.length === 0 ? (
                <Typography role="body" colour="secondary">
                  No sources are recorded for this person.
                </Typography>
              ) : (
                sourceLines.map((source) => <SourceRow key={source.id} source={source} />)
              )}
            </Card>
          </View>
        ) : null}

        {layer === 'RECORDS' ? (
          <View style={styles.stack}>
            <ResourceState resource={records} onRetry={reloadRecords} />
            {recordLines.length === 0 ? (
              <Card>
                <Typography role="body">
                  No records have been added for this person yet. A record is a lab report, a
                  letter, a vaccination or an annual check.
                </Typography>
              </Card>
            ) : (
              recordLines.map((record) => (
                <RecordRow
                  key={record.id}
                  record={record}
                  onOpen={() => setOpenRecordId(record.id)}
                />
              ))
            )}
          </View>
        ) : null}

        {layer === 'TRENDS' ? (
          <View style={styles.stack}>
            <ResourceState resource={measurements} />
            {trends.length === 0 ? (
              <Card>
                <Typography role="body">
                  No measurements have been recorded. Kynviora is not connected to a watch, a scale
                  or a clinic, so nothing arrives here on its own.
                </Typography>
              </Card>
            ) : (
              trends.map((trend) => <TrendCard key={trend.label} trend={trend} />)
            )}
          </View>
        ) : null}

        {layer === 'HISTORY' ? (
          <View style={styles.stack}>
            <ResourceState resource={timeline} />
            <Card>
              <SectionHeader
                title="Everything, in order"
                explanation="Records, allergies, conditions and sources together."
              />
              {timelineEntries.length === 0 ? (
                <Typography role="body" colour="secondary">
                  Nothing has been recorded yet.
                </Typography>
              ) : (
                timelineEntries.map((entry) => (
                  <TimelineRow key={`${entry.entryKind}:${entry.entryId}`} entry={entry} />
                ))
              )}
            </Card>
          </View>
        ) : null}
      </Screen>
    </>
  );
}

const makeStyles = (_theme: Theme) =>
  StyleSheet.create({
    stack: { gap: SPACING.lg },
    metricRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: SPACING.sm,
      paddingVertical: SPACING.xs,
    },
  });
