/**
 * The Global Regulatory Lens.
 *
 * Spec references: `04` Phase 7.2 (jurisdiction cards; status label plus icon and text, never
 * colour alone; prohibited versus restricted versus concentration, use and warning conditions;
 * product and batch official actions), `09` (statuses are a list; limitations accompany every
 * status; coverage accompanies every absence; a scientific opinion is not law; no jurisdiction
 * ranking), `07`, DEC-007, DEC-016, `BLK-004`.
 *
 * ONE CARD PER JURISDICTION, IN THE ORDER THEY WERE ASKED FOR
 * Not sorted, not grouped by how prohibitive each answer is, and never compared. `09` forbids
 * "strict country" and "weak regulation" framing, and a list ordered by severity is that framing
 * with the words left out. GB and NI are separate cards for the same reason they are separate
 * jurisdictions (trap 2).
 *
 * EVERY CARD CARRIES ITS OWN LIMITS
 * `09` requires the limitation copy and the coverage statement to travel with the status rather
 * than sit once at the bottom of the screen. A person reading only one card must see what that
 * card does not mean.
 *
 * WHY MOST OF THIS SCREEN IS CURRENTLY EMPTY
 * DEC-016: every shipped regulatory fixture is deliberately rejected by the Citation Gate,
 * because the research behind them came from search summaries rather than retrieved official
 * documents (`BLK-004`). So the Lens has no published rule to project and every card says so.
 * That is the design working, and the card says it in a sentence rather than by being blank.
 */

import { View, Text, StyleSheet } from 'react-native';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  LENS_COPY,
  undescribedStatusNote,
  type ScreenState as ScreenStateKind,
} from '@kynviora/presentation';
import type { LensJurisdictionCardView, LensView } from '@kynviora/contracts';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import { StatusChip } from '@/components/StatusChip';

export interface RegulatoryLensProps {
  readonly substanceKey: string;
  readonly view: LensView | null;
  readonly state: ScreenStateKind;
  readonly onClose: () => void;
}

export function RegulatoryLens({ substanceKey, view, state, onClose }: RegulatoryLensProps) {
  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        {LENS_COPY.heading}
      </Text>
      <Text style={styles.body}>{substanceKey}</Text>

      {state !== 'READY' && state !== 'EMPTY' ? <ScreenState state={state} /> : null}

      {view === null
        ? null
        : view.cards.map((card) => (
            <JurisdictionCard key={String(card.jurisdiction)} card={card} />
          ))}

      {/* Reported, never omitted. A jurisdiction silently missing from a list reads as "nothing
          to say there", which is absence-as-approval with a map instead of a label. */}
      {view !== null && view.unmonitoredJurisdictions.length > 0 ? (
        <Text style={styles.limitation}>
          {LENS_COPY.unmonitoredPrefix}: {view.unmonitoredJurisdictions.join(', ')}.
        </Text>
      ) : null}

      <PrimaryButton label={LENS_COPY.backLabel} variant="secondary" onPress={onClose} />
    </View>
  );
}

function JurisdictionCard({ card }: { readonly card: LensJurisdictionCardView }) {
  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.jurisdiction}>
        {String(card.jurisdiction)}
      </Text>

      {/* Every applicable status, each with its own label and icon. `07` forbids collapsing them
          into one and `18` forbids relying on tone. */}
      {card.statuses.map((status, index) => (
        <StatusChip
          key={`${status.label}-${String(index)}`}
          presentation={status}
          showDescription
        />
      ))}

      {card.noStatusNote === null ? null : <Text style={styles.body}>{card.noStatusNote}</Text>}

      {/* Counted, not hidden. Every word comes from the presentation layer: `apps/**` is excluded
          from the test run, so a string defined here is copy no scan looks at (trap 39). */}
      {undescribedStatusNote(card.undescribedStatuses) === null ? null : (
        <Text style={styles.limitation}>{undescribedStatusNote(card.undescribedStatuses)}</Text>
      )}

      {/* The second axis, always. DEC-007: whether the rule bites is a different question from
          what it says, and there is no combined "compliant" verdict anywhere. */}
      <StatusChip presentation={card.applicability} showDescription />

      {card.unresolved.map((condition) => (
        <Text key={condition.condition} style={styles.limitation}>
          {condition.explanation}
        </Text>
      ))}

      {card.authority === null ? null : (
        <Text style={styles.limitation}>
          Source: {card.authority}
          {card.legalInstrument === null ? '' : `, ${card.legalInstrument}`}
          {card.legalReference === null ? '' : `, ${card.legalReference}`}
          {card.publicationDate === null ? '' : `, published ${card.publicationDate}`}.
        </Text>
      )}

      {card.lastVerifiedAt === null ? null : (
        <Text style={styles.limitation}>Last checked {card.lastVerifiedAt.slice(0, 10)}.</Text>
      )}

      {/* `09` requires the coverage statement alongside an absence, and it is shown either way. */}
      <Text style={styles.limitation}>{card.coverageStatement}</Text>

      {/* What this does not mean, on the card rather than once at the foot of the screen. */}
      {card.limitations.map((limitation) => (
        <Text key={limitation} style={styles.limitation}>
          {limitation}
        </Text>
      ))}

      {/* Under their own heading. An opinion is not a legal status, however authoritative, and
          whether any law implements it is stated rather than implied (`09`). */}
      {card.scientificOpinions.length > 0 ? (
        <>
          <Text style={styles.label}>{LENS_COPY.opinionHeading}</Text>
          {card.scientificOpinions.map((opinion) => (
            <Text key={opinion.reference} style={styles.limitation}>
              {opinion.committee}: {opinion.summary}{' '}
              {opinion.hasImplementingLaw
                ? LENS_COPY.opinionImplemented
                : LENS_COPY.opinionNotImplemented}
            </Text>
          ))}
        </>
      ) : null}

      {card.productActions.length > 0 ? (
        <>
          <Text style={styles.label}>{LENS_COPY.actionsHeading}</Text>
          {card.productActions.map((action) => (
            <Text key={`${action.actionKind}-${action.summary}`} style={styles.limitation}>
              {action.authority}: {action.summary}
              {action.effectiveDate === null ? '' : ` (from ${action.effectiveDate})`}
            </Text>
          ))}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: SPACING.md },
  heading: {
    fontSize: FONT_SIZE.title,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  card: {
    gap: SPACING.sm,
    padding: SPACING.md,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
    backgroundColor: LIGHT_THEME.surface.background,
  },
  jurisdiction: {
    fontSize: FONT_SIZE.body,
    fontWeight: '700',
    color: LIGHT_THEME.surface.foreground,
  },
  label: {
    fontSize: FONT_SIZE.body,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  body: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.normal,
    color: LIGHT_THEME.surface.foreground,
  },
  limitation: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
});
