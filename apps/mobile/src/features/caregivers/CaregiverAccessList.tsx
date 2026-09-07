/**
 * Caregiver access list.
 *
 * Spec references: `06` Journey 6 and its required screen states, `03` group H (explicit grants,
 * revocation, audit visibility), `18` (plain language, 48dp targets, never colour alone),
 * `12` (no client-side authorization, no optimistic change to a caregiver grant), DEC-130,
 * DEC-142.
 *
 * WHAT THIS SCREEN DELIBERATELY DOES NOT DO
 * It never decides who may see anything. `12` forbids the client from holding authorization
 * logic, and `13` makes grant mutation a privileged server operation - so this component renders
 * what the server returned and asks the server for every change. There is no local capability
 * check anywhere in this file, and there is no optimistic update: a grant shown as removed before
 * the server agreed would be a false statement about who can see a person's health data.
 *
 * WHY IT NO LONGER SCROLLS ITSELF (DEC-142)
 * It used to hold its own `ScrollView` inside the one `care.tsx` already had - two scroll views
 * nested in the same direction, which on Android is one of them eating the other's gestures. It
 * also drew its own screen heading, so Care had two ways of saying what screen this is. Both were
 * artefacts of Care being the one destination that did not use `Screen`; it does now, and this
 * renders content.
 *
 * WHY A GRANT IS THREE BLOCKS AND NOT A ROW OF CHIPS
 * "What they can see", "what they can change" and "what is not shared" are three different
 * questions, they are separately granted (DEC-116), and the third is the one somebody actually
 * came to check. Capabilities used to be a row of small grey chips with the withheld list as one
 * lowercased caption underneath - which reads as a tag cloud with a footnote, so the granted set
 * was scannable and the withheld set was not. `summarizeAccess` already composes all three and
 * already has the copy; this renders them at the same rank and in the same shape, because `18`
 * will not let a limitation sit a level below the thing it qualifies and this screen is entirely
 * about limitations.
 */

import { View, StyleSheet } from 'react-native';
import {
  CAREGIVER_COPY,
  RADIUS,
  SPACING,
  presentCaregiverAccess,
  summarizeAccess,
  type CaregiverAccessState,
  type Theme,
} from '@kynviora/presentation';
import type { CaregiverCapability } from '@kynviora/domain';
import { isRemovable, type AccessHistoryView } from '@kynviora/contracts';
import { AccessHistory } from './AccessHistory';
import { Card } from '@/components/Card';
import { SectionHeader } from '@/components/SectionHeader';
import { StatusChip } from '@/components/StatusChip';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import { Typography } from '@/components/Typography';
import type { ScreenState as ScreenStateKind } from '@kynviora/presentation';
import { useThemedStyles } from '@/theme/ThemeProvider';

/** One row, as the API returns it. */
export interface CaregiverAccessRow {
  readonly id: string;
  /**
   * Which record this row is.
   *
   * Carried through to the remove control, because the ID alone does not say which route
   * withdraws it and the wrong one answers 404 - which reads on screen as the row vanishing.
   */
  readonly subject: 'GRANT' | 'INVITATION';
  readonly state: CaregiverAccessState;
  readonly capabilities: readonly CaregiverCapability[];
  /**
   * How the caregiver is identified on screen.
   *
   * A display name chosen by the profile owner, never an email address: `14` treats an address
   * as personal data and a shared screen should not put one on display.
   */
  readonly displayName: string;
  readonly expiresAt: string | null;
  /** Whether this row is the caller's own access. From the server, never inferred here. */
  readonly isSelf: boolean;
}

export interface CaregiverAccessListProps {
  readonly state: ScreenStateKind;
  readonly rows: readonly CaregiverAccessRow[];
  /** Invoked for a revoke. The caller performs the step-up prompt and the request. */
  readonly onRevoke: (id: string) => void;
  /**
   * Open the invitation flow, or `null` where this caller may invite nobody.
   *
   * Absent rather than disabled, for the same reason a capability they cannot delegate is absent
   * from the invite screen (DEC-045): a greyed-out control states that the action exists and that
   * this person is not trusted with it.
   */
  readonly onInvite: (() => void) | null;
  readonly onRetry?: () => void;
  /** `03` group H: what happened to access, which the current list cannot show. */
  readonly history?: AccessHistoryView;
}

export function CaregiverAccessList({
  state,
  rows,
  onRevoke,
  onInvite,
  onRetry,
  history,
}: CaregiverAccessListProps) {
  if (state !== 'READY') {
    // Every non-success state is rendered explicitly. `06` treats a screen with only a success
    // path as incomplete, and this one can genuinely be offline, stale or newly unauthorized.
    return <ScreenState state={state} {...(onRetry ? { onRetry } : {})} />;
  }

  return (
    <>
      <SectionHeader title="Who can see this profile" explanation={CAREGIVER_COPY.inviteIntro} />

      {rows.length === 0 ? (
        <ScreenState state="EMPTY" message={CAREGIVER_COPY.emptyState} />
      ) : (
        rows.map((row) => <CaregiverRow key={row.id} row={row} onRevoke={onRevoke} />)
      )}

      {onInvite === null ? null : <PrimaryButton label="Invite someone" onPress={onInvite} />}

      {/* After a removal the list is one row shorter, which is the least informative possible
          confirmation. The history is where the removal itself is visible (`03` group H). */}
      {history === undefined ? null : <AccessHistory history={history} />}
    </>
  );
}

function CaregiverRow({
  row,
  onRevoke,
}: {
  readonly row: CaregiverAccessRow;
  readonly onRevoke: (id: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const presentation = presentCaregiverAccess(row.state);
  const summary = summarizeAccess(row.capabilities);
  // The same predicate the confirmation uses. Two independent conditions is how a control
  // appears on a row whose builder then refuses it.
  const canRevoke = isRemovable(row);

  return (
    <Card>
      <Typography role="title" heading>
        {row.displayName}
      </Typography>

      {/* The state is carried by the chip, which always renders a label and a shape icon. */}
      <StatusChip presentation={presentation} showDescription />

      {/* Three blocks, in the same shape and at the same rank: what they can see, what they can
          change, and what is not shared at all. `summarizeAccess` composes all three - seeing and
          changing are separate because they are separately granted (DEC-116), and the third is the
          one somebody actually came to check. It used to be a caption under a row of grey chips,
          which made the granted set scannable and the withheld set a footnote. */}
      <CapabilityBlock title="What they can see" entries={summary.viewing} />
      <CapabilityBlock title="What they can change" entries={summary.changing} />
      <CapabilityBlock title="Not shared with them" entries={summary.notIncluded} />

      {/* Two facts that qualify the grant rather than describing it, so they sit under both
          blocks as captions rather than inside either. */}
      {summary.administrationWarning === null ? null : (
        <Typography role="caption" colour="secondary">
          {summary.administrationWarning}
        </Typography>
      )}

      {row.expiresAt === null ? null : (
        <Typography role="caption" colour="secondary">
          Access ends on {row.expiresAt.slice(0, 10)}.
        </Typography>
      )}

      {canRevoke ? (
        <PrimaryButton
          label="Remove access"
          // The label already says what happens; the hint carries the consequence for a screen
          // reader without making the visible label long enough to wrap awkwardly.
          accessibilityHint={CAREGIVER_COPY.revokeConfirm}
          style={styles.remove}
          onPress={() => {
            onRevoke(row.id);
          }}
        />
      ) : null}
    </Card>
  );
}

/**
 * One labelled list, or nothing.
 *
 * Absent rather than empty, and that is the interesting case: "what they can change - nothing" is
 * a sentence with two readings, and the wrong one is that changing is a thing this grant does at a
 * level below what is listed. The other two blocks say what the grant is; a block with no entries
 * says nothing and is not drawn.
 */
function CapabilityBlock({
  title,
  entries,
}: {
  readonly title: string;
  readonly entries: readonly string[];
}) {
  const styles = useThemedStyles(makeStyles);
  if (entries.length === 0) return null;
  return (
    <View style={styles.block}>
      <Typography role="label" colour="secondary" heading>
        {title}
      </Typography>
      {entries.map((entry) => (
        <Typography key={entry} role="body">
          {entry}
        </Typography>
      ))}
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    // A sunken well: "this is about the record", the same treatment a read-only block gets
    // everywhere else. Deliberately not a tone - a coloured panel here would be a colour making a
    // claim about somebody's access, and the two lists must read as equally important.
    block: {
      gap: SPACING.xxs,
      padding: SPACING.md,
      borderRadius: RADIUS.md,
      backgroundColor: theme.sunken.background,
    },
    remove: { marginTop: SPACING.xs },
  });
