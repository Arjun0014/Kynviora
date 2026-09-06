/**
 * The confirmation screen for deleting an item.
 *
 * Spec references: `16` (the deletion workflow enumerates what goes and what is retained),
 * `18` (confirm a destructive action; say what a screen will do before it does it), `12` (no
 * client-side authorization; no optimistic change), `14` (deletion needs re-authentication),
 * DEC-117, `docs/RETENTION.md`.
 *
 * WHY A SCREEN RATHER THAN AN ALERT
 * The same argument `RemoveCaregiverAccess` makes, and for the same reason it was right there.
 * The consequential facts are what goes, what stays and when - and two of those surprise people:
 * a dose history goes with the medicine, and the record that a deletion happened does not go at
 * all. A two-button alert has nowhere to put either, so it puts neither.
 *
 * IT NEVER APPLIES THE CHANGE ITSELF
 * There is no local state here meaning "deleted" and this component does not touch the shelf.
 * `12` forbids the client holding authorization logic, and a row that vanishes before the server
 * agreed is a false statement about somebody's health record - in the direction that reassures.
 * The caller performs the request with an elevated client and reloads.
 *
 * THE ALTERNATIVE IS OFFERED FIRST
 * `DEV-032` was archiving being offered where deletion belonged. Now that both exist the risk
 * runs the other way: deletion is the control that sounds final, so a person who wants Kynviora
 * to stop asking about a finished course reaches for it. The sentence pointing at the other
 * control is above the confirm button rather than below it (`10`).
 */

import { View, Text, StyleSheet } from 'react-native';
import {
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  ITEM_DELETION_COPY,
  describeItemDeletion,
  type ScreenState as ScreenStateKind,
  type Theme,
} from '@kynviora/presentation';
import type { ItemKind } from '@kynviora/domain';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import { useThemedStyles } from '@/theme/ThemeProvider';

export interface DeleteItemProps {
  readonly displayName: string;
  readonly itemKind: ItemKind;
  /** Performed with an elevated client. The caller owns the step-up, not this component. */
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly state?: ScreenStateKind | null;
  readonly stateMessage?: string | null;
  /** Set once the server has answered. Distinct from `state === 'READY'`, which is the form. */
  readonly deleted?: boolean;
  /**
   * Opens the lifecycle controls instead.
   *
   * Absent where the caller may not edit, which is possible: ownership admits deletion and the
   * item's kind decides editing, so an owner always has both and this stays defensive rather
   * than assuming they coincide.
   */
  readonly onArchiveInstead?: () => void;
}

export function DeleteItem({
  displayName,
  itemKind,
  onConfirm,
  onCancel,
  state,
  stateMessage,
  deleted,
  onArchiveInstead,
}: DeleteItemProps) {
  const styles = useThemedStyles(makeStyles);
  const words = describeItemDeletion(itemKind);

  if (deleted === true) {
    return (
      <View style={styles.container}>
        <Text accessibilityRole="header" style={styles.heading}>
          {ITEM_DELETION_COPY.doneHeading}
        </Text>
        <Text accessibilityLiveRegion="polite" style={styles.body}>
          {ITEM_DELETION_COPY.doneNote}
        </Text>
        <PrimaryButton label={ITEM_DELETION_COPY.doneLabel} onPress={onCancel} />
      </View>
    );
  }

  if (state != null && state !== 'READY') {
    // Every failure renders as a state, including step-up. The one message shown is the server's
    // own, which `errors.ts` has already made client-safe - never a reason invented here, and in
    // particular never a guess at whether a refusal was "not allowed" or "not there".
    return (
      <View style={styles.container}>
        <ScreenState state={state} message={stateMessage} />
        <PrimaryButton
          label={ITEM_DELETION_COPY.cancelLabel}
          variant="secondary"
          onPress={onCancel}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        {words.heading}
      </Text>
      <Text style={styles.name}>{displayName}</Text>

      {/* What goes. `16` requires this enumerated, and the list differs by item kind because the
          two kinds have different children - a shampoo has no doses to remove. */}
      <Text accessibilityRole="header" style={styles.label}>
        {words.goesHeading}
      </Text>
      {words.goes.map((line) => (
        <Text key={line} style={styles.body}>
          {line}
        </Text>
      ))}

      <Text style={styles.body}>{words.immediate}</Text>
      <Text style={styles.body}>{words.caregiverNote}</Text>

      {/* What stays, in its own block so it is not read as a footnote to the list above. `16`
          forbids claiming universal erasure while retained records have a specified lifecycle,
          and this is that sentence. */}
      <View style={styles.kept}>
        <Text accessibilityRole="header" style={styles.label}>
          {words.staysHeading}
        </Text>
        <Text style={styles.body}>{words.stays}</Text>
      </View>

      <Text style={styles.body}>{words.noUndo}</Text>

      {/* Above the buttons (`10`), because a person who has already pressed one is not reading
          the paragraph underneath it. */}
      {onArchiveInstead === undefined ? null : (
        <>
          <Text style={styles.body}>{words.archiveAlternative}</Text>
          <PrimaryButton
            label="Mark it as no longer used instead"
            variant="secondary"
            onPress={onArchiveInstead}
          />
        </>
      )}

      <Text style={styles.body}>{words.stepUpPrompt}</Text>

      <PrimaryButton
        label={words.confirmLabel}
        accessibilityHint={words.noUndo}
        onPress={onConfirm}
      />
      <PrimaryButton label={words.cancelLabel} variant="secondary" onPress={onCancel} />
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      gap: SPACING.md,
      padding: SPACING.md,
      borderWidth: 1,
      borderRadius: SPACING.sm,
      borderColor: theme.surface.border,
      backgroundColor: theme.surface.background,
    },
    heading: {
      fontSize: FONT_SIZE.title,
      fontWeight: '600',
      color: theme.surface.foreground,
    },
    name: {
      fontSize: FONT_SIZE.body,
      fontWeight: '600',
      color: theme.surface.foreground,
    },
    label: {
      fontSize: FONT_SIZE.body,
      fontWeight: '600',
      color: theme.surface.foreground,
    },
    body: {
      fontSize: FONT_SIZE.body,
      lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.normal,
      color: theme.surface.foreground,
    },
    // Informational rather than attention-toned. What is kept is a fact about how the product
    // works, not a warning, and styling it as a warning would make the honest sentence read as a
    // reason to hesitate.
    kept: {
      gap: SPACING.xs,
      padding: SPACING.md,
      borderWidth: 1,
      borderRadius: SPACING.sm,
      borderColor: theme.informational.border,
      backgroundColor: theme.informational.background,
    },
  });
