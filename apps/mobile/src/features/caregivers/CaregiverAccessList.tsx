/**
 * Caregiver access list.
 *
 * Spec references: `06` Journey 6 and its required screen states, `03` group H (explicit grants,
 * revocation, audit visibility), `18` (plain language, 48dp targets, never colour alone),
 * `12` (no client-side authorization, no optimistic change to a caregiver grant).
 *
 * WHAT THIS SCREEN DELIBERATELY DOES NOT DO
 * It never decides who may see anything. `12` forbids the client from holding authorization
 * logic, and `13` makes grant mutation a privileged server operation - so this component renders
 * what the server returned and asks the server for every change. There is no local capability
 * check anywhere in this file, and there is no optimistic update: a grant shown as removed before
 * the server agreed would be a false statement about who can see a person's health data.
 */

import { View, Text, StyleSheet, ScrollView } from 'react-native';
import {
  CAREGIVER_COPY,
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  describeCapability,
  presentCaregiverAccess,
  summarizeAccess,
  type CaregiverAccessState,
} from '@kynviora/presentation';
import type { CaregiverCapability } from '@kynviora/domain';
import { isRemovable, type AccessHistoryView } from '@kynviora/contracts';
import { AccessHistory } from './AccessHistory';
import { StatusChip } from '@/components/StatusChip';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import type { ScreenState as ScreenStateKind } from '@kynviora/presentation';

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
    <ScrollView contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={styles.heading}>
        Who can see this profile
      </Text>
      <Text style={styles.intro}>{CAREGIVER_COPY.inviteIntro}</Text>

      {rows.length === 0 ? (
        <ScreenState state="EMPTY" message={CAREGIVER_COPY.emptyState} />
      ) : (
        rows.map((row) => <CaregiverRow key={row.id} row={row} onRevoke={onRevoke} />)
      )}

      {onInvite === null ? null : <PrimaryButton label="Invite someone" onPress={onInvite} />}

      {/* After a removal the list is one row shorter, which is the least informative possible
          confirmation. The history is where the removal itself is visible (`03` group H). */}
      {history === undefined ? null : <AccessHistory history={history} />}
    </ScrollView>
  );
}

function CaregiverRow({
  row,
  onRevoke,
}: {
  readonly row: CaregiverAccessRow;
  readonly onRevoke: (id: string) => void;
}) {
  const presentation = presentCaregiverAccess(row.state);
  const summary = summarizeAccess(row.capabilities);
  // The same predicate the confirmation uses. Two independent conditions is how a control
  // appears on a row whose builder then refuses it.
  const canRevoke = isRemovable(row);

  return (
    <View style={styles.row}>
      <Text style={styles.name}>{row.displayName}</Text>

      {/* The state is carried by the chip, which always renders a label and a shape icon. */}
      <StatusChip presentation={presentation} showDescription />

      {row.capabilities.length > 0 ? (
        <View style={styles.capabilities}>
          {row.capabilities.map((capability) => (
            <Text key={capability} style={styles.capability}>
              {describeCapability(capability).label}
            </Text>
          ))}
        </View>
      ) : null}

      {/* What was withheld, not only what was granted. */}
      {summary.notIncluded.length > 0 ? (
        <Text style={styles.limitation}>
          Not shared: {summary.notIncluded.join(', ').toLowerCase()}.
        </Text>
      ) : null}

      {summary.administrationWarning !== null ? (
        <Text style={styles.limitation}>{summary.administrationWarning}</Text>
      ) : null}

      {row.expiresAt !== null ? (
        <Text style={styles.limitation}>Access ends on {row.expiresAt.slice(0, 10)}.</Text>
      ) : null}

      {canRevoke ? (
        <PrimaryButton
          label="Remove access"
          // The label already says what happens; the hint carries the consequence for a screen
          // reader without making the visible label long enough to wrap awkwardly.
          accessibilityHint={CAREGIVER_COPY.revokeConfirm}
          onPress={() => {
            onRevoke(row.id);
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: SPACING.lg, gap: SPACING.md },
  heading: {
    fontSize: FONT_SIZE.heading,
    fontWeight: '700',
    color: LIGHT_THEME.surface.foreground,
  },
  intro: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
  row: {
    gap: SPACING.sm,
    padding: SPACING.md,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
    backgroundColor: LIGHT_THEME.surface.background,
  },
  name: {
    fontSize: FONT_SIZE.title,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  capabilities: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs },
  capability: {
    fontSize: FONT_SIZE.caption,
    color: LIGHT_THEME.surfaceMuted.foreground,
    backgroundColor: LIGHT_THEME.surfaceMuted.background,
    borderRadius: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  limitation: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
});
