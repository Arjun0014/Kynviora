/**
 * The pieces the Health screen is built from.
 *
 * Spec references: `06` (Health is a primary destination, amended by DEC-151), `09`/`10` (a source
 * fact and a Kynviora conclusion are different things), `18` (meaning never by colour alone; one
 * heading per screen; 48dp targets; system font scaling), `02` (no score, no ranking), DEC-138
 * (a coverage statement is a card at the same rank as the results, first), DEC-153, DEC-155.
 *
 * WHY THESE ARE HERE AND NOT IN THE ROUTE FILE
 * `apps/mobile/src/app` is Expo Router's route directory and every file under it is a route
 * (trap 201). A component file there would become a navigable screen; a test file there breaks
 * the bundle. So the screen is a route and everything it is made of lives outside.
 *
 * WHAT NONE OF THESE COMPONENTS DOES
 * Decide anything about a value. `outsideReportedInterval` arrives from the view layer, which
 * got it from the server, which got it from `referenceComparison` - and the word beside it on
 * screen is always about the report ("Outside the range this report gave"), never about the
 * person. There is no component here that could render "High".
 */

import { View, StyleSheet, Pressable } from 'react-native';
import {
  MIN_TOUCH_TARGET_DP,
  RADIUS,
  SPACING,
  changeClassPresentation,
  changeRowPresentation,
  type ChangeToneToken,
  type Theme,
} from '@kynviora/presentation';
import type { ChangeClass, ChangeEntry } from '@kynviora/domain';
import type {
  HealthObservationView,
  HealthRecordLineView,
  HealthSourceView,
  HealthTimelineEntryView,
  HealthTrendView,
} from '@kynviora/contracts';
import { Card } from '@/components/Card';
import { Typography } from '@/components/Typography';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';

// ---------------------------------------------------------------------------
// The four layers
// ---------------------------------------------------------------------------

/**
 * Which layer of Health is on screen.
 *
 * Four rather than one long scroll, because the four answer different questions and V3 says so:
 * *what does Kynviora know about this person, where did it come from, what changed, and how has
 * it evolved*. One screen holding all four would put a lab value from 2024 below a heart rate
 * from this morning.
 */
export const HEALTH_LAYERS = ['PROFILE', 'RECORDS', 'TRENDS', 'HISTORY'] as const;
export type HealthLayer = (typeof HEALTH_LAYERS)[number];

const LAYER_LABELS: Readonly<Record<HealthLayer, string>> = Object.freeze({
  PROFILE: 'Profile',
  RECORDS: 'Records',
  TRENDS: 'Trends',
  HISTORY: 'History',
});

export function HealthLayerPicker({
  layer,
  onChange,
}: {
  readonly layer: HealthLayer;
  readonly onChange: (next: HealthLayer) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const theme = useTheme();

  return (
    <View
      accessibilityRole="tablist"
      style={styles.segments}
      // Wraps rather than shrinking. At the 2x font scale this app supports, four segments on one
      // line clip their own labels - which is the thing `18` forbids, arriving through a control
      // rather than through a tab bar.
    >
      {HEALTH_LAYERS.map((candidate) => {
        const chosen = candidate === layer;
        return (
          <Pressable
            key={candidate}
            accessibilityRole="tab"
            accessibilityState={{ selected: chosen }}
            accessibilityLabel={`${LAYER_LABELS[candidate]}${chosen ? ', showing' : ''}`}
            onPress={() => onChange(candidate)}
            style={[
              styles.segment,
              {
                // `selection` - the one hue about the interface rather than about a product
                // (DEC-130). Never `informational`, which is what a fact about a medicine wears.
                backgroundColor: chosen ? theme.selection.background : theme.surface.background,
                borderColor: chosen ? theme.selection.border : theme.line.hairline,
              },
            ]}
          >
            <Typography role="label" colour={chosen ? 'informational' : 'secondary'} decorative>
              {LAYER_LABELS[candidate]}
            </Typography>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// A record
// ---------------------------------------------------------------------------

export function RecordRow({
  record,
  onOpen,
}: {
  readonly record: HealthRecordLineView;
  readonly onOpen: () => void;
}) {
  const styles = useThemedStyles(makeStyles);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${record.accessibilityLabel} Open.`}
      onPress={onOpen}
      style={styles.pressable}
    >
      <Card>
        <Typography role="overline" colour="secondary" decorative>
          {record.kindLabel}
        </Typography>
        <Typography role="title" decorative>
          {record.title}
        </Typography>
        <Typography role="caption" colour="secondary" decorative>
          {[record.providerName, record.recordedOn ?? 'No date recorded']
            .filter((part): part is string => part !== null)
            .join(' · ')}
        </Typography>

        <View style={styles.metaRow}>
          <MetaPill
            label={
              record.observationCount === 1 ? '1 result' : `${record.observationCount} results`
            }
          />
          {record.sourceFlaggedCount > 0 ? (
            // The report's own count, worded as the report's. `sourceFlaggedCount`, never
            // "abnormal": the number is how many results the lab marked, and the sentence says so.
            <MetaPill
              label={`${record.sourceFlaggedCount} flagged by the report`}
              tone="attention"
            />
          ) : null}
          {record.hasDocument ? <MetaPill label="Document on file" /> : null}
        </View>

        {/*
          Always rendered, never conditional on being interesting. `04` Phase 1.3: a result read
          from a photograph and not checked has to say so beside the numbers, and a sentence that
          appears only sometimes is one a person learns to stop looking for.
        */}
        <Typography role="caption" colour="secondary" decorative>
          {record.provenanceSentence}
        </Typography>
      </Card>
    </Pressable>
  );
}

function MetaPill({ label, tone }: { readonly label: string; readonly tone?: ChangeToneToken }) {
  const styles = useThemedStyles(makeStyles);
  const theme = useTheme();
  const pair = tone === undefined ? theme.surfaceMuted : theme[tone];
  return (
    <View style={[styles.pill, { backgroundColor: pair.background, borderColor: pair.border }]}>
      <Typography role="caption" style={{ color: pair.foreground }} decorative>
        {label}
      </Typography>
    </View>
  );
}

// ---------------------------------------------------------------------------
// One result
// ---------------------------------------------------------------------------

/**
 * A lab result, with the interval the report printed drawn beside it.
 *
 * The band is the report's, the mark is this value, and the words say whose statement each is.
 * There is no colour on this row that means "bad": a value outside the printed band is drawn in
 * `attention` **with the sentence beside it**, and the sentence names the report.
 */
export function ObservationRow({ observation }: { readonly observation: HealthObservationView }) {
  const styles = useThemedStyles(makeStyles);
  const theme = useTheme();

  return (
    <View accessible accessibilityLabel={observation.accessibilityLabel} style={styles.result}>
      <View style={styles.resultHead}>
        <Typography role="label" decorative style={styles.resultName}>
          {observation.displayName}
        </Typography>
        <Typography role="label" decorative>
          {observation.valueText}
        </Typography>
      </View>

      {observation.referenceText === null ? (
        // Not "fine" and not "unknown risk" - the plain fact that this report printed no range.
        // Stated rather than omitted, because a blank where a range belongs reads as no range
        // being needed (DEC-155).
        <Typography role="caption" colour="secondary" decorative>
          This report gave no range.
        </Typography>
      ) : (
        <ReferenceBand observation={observation} />
      )}

      {observation.outsideReportedInterval ? (
        <View
          style={[
            styles.note,
            { backgroundColor: theme.attention.background, borderColor: theme.attention.border },
          ]}
        >
          <Typography role="caption" style={{ color: theme.attention.foreground }} decorative>
            {observation.referenceComparison === 'OUTSIDE_ABOVE' ? 'Above' : 'Below'} the range this
            report gave. Kynviora adds no interpretation.
          </Typography>
        </View>
      ) : null}

      {observation.sourceFlagSentence === null ? null : (
        <View
          style={[
            styles.note,
            { backgroundColor: theme.attention.background, borderColor: theme.attention.border },
          ]}
        >
          <Typography role="caption" style={{ color: theme.attention.foreground }} decorative>
            {observation.sourceFlagSentence}
          </Typography>
        </View>
      )}
    </View>
  );
}

/**
 * The interval as a band, with a mark where the value sits.
 *
 * Drawn only where the report gave two numbers - a text interval has nothing to draw and is
 * printed as the report printed it. The mark is clamped into the track so a value far outside the
 * range stays on screen; the words above it, not the position, are what say where it is.
 */
function ReferenceBand({ observation }: { readonly observation: HealthObservationView }) {
  const styles = useThemedStyles(makeStyles);
  const theme = useTheme();
  const low = observation.reference?.low ?? null;
  const high = observation.reference?.high ?? null;
  const value = observation.valueNumeric ?? null;

  // Narrowed by the three checks rather than asserted afterwards: `drawable` as a boolean would
  // carry no type information to the arithmetic below, and the casts that filled that gap are the
  // shape a nullable value takes just before somebody removes one of the checks.
  const drawable = low !== null && high !== null && value !== null && high > low;
  // The band occupies the middle 60% of the track, so a value outside it has somewhere to be.
  // Clamped, so a value far outside the range stays on screen - the words above it, never the
  // position, are what say where it is.
  const markPercent = drawable
    ? Math.max(0, Math.min(1, 0.2 + ((value - low) / (high - low)) * 0.6)) * 100
    : 0;

  return (
    <View style={styles.bandBlock}>
      <Typography role="caption" colour="secondary" decorative>
        {`This report gives a range of ${observation.referenceText ?? ''}`}
      </Typography>
      {drawable ? (
        <View style={[styles.track, { backgroundColor: theme.sunken.background }]}>
          <View
            style={[
              styles.band,
              { backgroundColor: theme.positive.background, borderColor: theme.positive.border },
            ]}
          />
          <View
            style={[
              styles.mark,
              {
                left: `${markPercent}%`,
                backgroundColor: observation.outsideReportedInterval
                  ? theme.attention.foreground
                  : theme.surface.foreground,
              },
            ]}
          />
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// The change lens on screen
// ---------------------------------------------------------------------------

/**
 * One section of a comparison.
 *
 * `SIMILAR` is collapsed by default and the collapse is stated rather than silent: the count is
 * on the header, so a person sees that thirty-four results did not move without scrolling past
 * thirty-four rows.
 */
export function ChangeSection({
  classification,
  entries,
  expanded,
  onToggle,
}: {
  readonly classification: ChangeClass;
  readonly entries: readonly ChangeEntry[];
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const presentation = changeClassPresentation(classification);
  if (entries.length === 0) return null;

  return (
    <Card tone={presentation.tone}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${presentation.accessibilityLabel} ${entries.length}. ${expanded ? 'Showing' : 'Hidden'}.`}
        onPress={onToggle}
        style={styles.sectionHead}
      >
        <Typography role="label" colour="primary" decorative>
          {`${presentation.label} · ${entries.length}`}
        </Typography>
        <Typography role="caption" colour="secondary" decorative>
          {expanded ? 'Hide' : 'Show'}
        </Typography>
      </Pressable>
      <Typography role="caption" colour="secondary" decorative>
        {presentation.description}
      </Typography>

      {expanded
        ? entries.map((entry) => {
            const row = changeRowPresentation(entry);
            return (
              <View
                key={entry.key}
                accessible
                accessibilityLabel={row.accessibilityLabel}
                style={styles.changeRow}
              >
                <Typography role="label" decorative style={styles.resultName}>
                  {row.label}
                </Typography>
                <Typography role="caption" colour="secondary" decorative>
                  {row.previousText === null || row.currentText === null
                    ? (row.currentText ?? row.previousText ?? '—')
                    : `${row.previousText} → ${row.currentText}`}
                  {row.deltaText === null
                    ? ''
                    : `  ${row.directionGlyph} ${row.deltaText}${row.relativeText === null ? '' : ` (${row.relativeText})`}`}
                </Typography>
                {row.incomparableNote === null ? null : (
                  <Typography role="caption" colour="secondary" decorative>
                    {row.incomparableNote}
                  </Typography>
                )}
              </View>
            );
          })
        : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// A trend
// ---------------------------------------------------------------------------

/**
 * One metric, with its readings drawn as a sparkline of bars.
 *
 * Bars rather than a line, for every metric, and the reason is `metricIsContinuouslySampled`: a
 * connecting line asserts the quantity took the intermediate values, which is false for a weight
 * measured twice a month. Where the metric *is* continuously sampled the bars sit adjacent and
 * read as a line; where it is not, they stay apart and read as readings - which is what they are.
 *
 * A gap is a gap. Nothing here interpolates, and `largestGapDays` is printed under the chart so a
 * gap is stated as well as shown.
 */
export function TrendCard({
  trend,
  onOpen,
}: {
  readonly trend: HealthTrendView;
  readonly onOpen?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const theme = useTheme();

  const values = trend.points.map((p) => p.value);
  const highest = values.length === 0 ? 1 : Math.max(...values);
  const lowest = values.length === 0 ? 0 : Math.min(...values);
  const span = highest - lowest === 0 ? 1 : highest - lowest;

  const body = (
    <Card>
      <View style={styles.metaRow}>
        <Typography role="title" decorative style={styles.resultName}>
          {trend.label}
        </Typography>
        <Typography role="label" colour="secondary" decorative>
          {trend.latestText ?? 'No readings'}
        </Typography>
      </View>

      {trend.points.length === 0 ? (
        <Typography role="caption" colour="secondary" decorative>
          Nothing has been recorded for this yet.
        </Typography>
      ) : (
        <>
          <View style={styles.spark}>
            {trend.points.slice(-24).map((point) => {
              // A paired reading draws the whole span from diastolic to systolic as one bar,
              // because that is what the reading is. Two bars would be two measurements.
              const top = point.value;
              const bottom = point.secondary ?? lowest;
              const height = Math.max(3, ((top - bottom) / span) * 40 + 3);
              const offset = ((bottom - lowest) / span) * 40;
              return (
                <View
                  key={point.id}
                  style={[
                    styles.sparkBar,
                    {
                      height,
                      marginBottom: offset,
                      backgroundColor: theme.selection.foreground,
                      marginRight: trend.connectPoints ? 0 : 2,
                    },
                  ]}
                />
              );
            })}
          </View>
          <Typography role="caption" colour="secondary" decorative>
            {`${trend.points.length} ${trend.points.length === 1 ? 'reading' : 'readings'}`}
            {trend.largestGapDays === null || trend.largestGapDays < 2
              ? ''
              : ` · longest gap ${trend.largestGapDays} days, shown as a gap`}
          </Typography>
        </>
      )}
    </Card>
  );

  if (onOpen === undefined) {
    return (
      <View accessible accessibilityLabel={trend.accessibilityLabel}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${trend.accessibilityLabel} Open.`}
      onPress={onOpen}
      style={styles.pressable}
    >
      {body}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// A source, and a timeline entry
// ---------------------------------------------------------------------------

export function SourceRow({ source }: { readonly source: HealthSourceView }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View accessible accessibilityLabel={source.accessibilityLabel} style={styles.result}>
      <View style={styles.metaRow}>
        <Typography role="label" decorative style={styles.resultName}>
          {source.displayName}
        </Typography>
        {/*
          The state has a word as well as a place in the list. `18` forbids meaning by colour
          alone, and the six honest states differ from each other only in words - which is the
          point: "imported once" and "connected" must not look the same at a glance.
        */}
        <MetaPill label={source.stateLabel} {...(source.isLive ? { tone: 'positive' } : {})} />
      </View>
      <Typography role="caption" colour="secondary" decorative>
        {source.stateSentence}
      </Typography>
    </View>
  );
}

export function TimelineRow({ entry }: { readonly entry: HealthTimelineEntryView }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View accessible accessibilityLabel={entry.accessibilityLabel} style={styles.result}>
      <View style={styles.metaRow}>
        <Typography role="overline" colour="secondary" decorative>
          {entry.kindLabel}
        </Typography>
        <Typography role="caption" colour="secondary" decorative>
          {entry.occurredAt.slice(0, 10)}
        </Typography>
      </View>
      <Typography role="body" decorative>
        {entry.title}
      </Typography>
      {entry.detail === null ? null : (
        <Typography role="caption" colour="secondary" decorative>
          {entry.detail}
        </Typography>
      )}
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    segments: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
    segment: {
      minHeight: MIN_TOUCH_TARGET_DP,
      justifyContent: 'center',
      paddingHorizontal: SPACING.lg,
      borderRadius: RADIUS.pill,
      borderWidth: 1,
    },
    pressable: { minHeight: MIN_TOUCH_TARGET_DP },
    metaRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: SPACING.sm,
    },
    pill: {
      borderWidth: 1,
      borderRadius: RADIUS.pill,
      paddingVertical: SPACING.xs,
      paddingHorizontal: SPACING.sm,
    },
    result: {
      gap: SPACING.xs,
      paddingVertical: SPACING.sm,
      borderTopWidth: 1,
      borderTopColor: theme.line.hairline,
    },
    resultHead: { flexDirection: 'row', justifyContent: 'space-between', gap: SPACING.sm },
    resultName: { flexShrink: 1 },
    note: {
      borderWidth: 1,
      borderRadius: RADIUS.sm,
      padding: SPACING.sm,
      marginTop: SPACING.xs,
    },
    bandBlock: { gap: SPACING.xs },
    track: { height: 10, borderRadius: RADIUS.pill, justifyContent: 'center' },
    band: {
      position: 'absolute',
      left: '20%',
      right: '20%',
      top: 0,
      bottom: 0,
      borderRadius: RADIUS.pill,
      borderWidth: 1,
    },
    mark: { position: 'absolute', width: 3, top: -3, bottom: -3, borderRadius: 2 },
    sectionHead: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      minHeight: MIN_TOUCH_TARGET_DP,
      gap: SPACING.sm,
    },
    changeRow: {
      gap: SPACING.xxs,
      paddingTop: SPACING.sm,
      borderTopWidth: 1,
      borderTopColor: theme.line.hairline,
    },
    spark: { flexDirection: 'row', alignItems: 'flex-end', height: 48, gap: 1 },
    sparkBar: { flex: 1, minWidth: 2, borderRadius: 1 },
  });
