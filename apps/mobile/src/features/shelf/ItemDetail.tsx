/**
 * One item on the shelf, and what is not settled about it.
 *
 * Spec references: `04` Phase 2.1 (item detail; "medicines and personal-care items coexist
 * without either being reduced to a generic note"; "a user can understand which items need
 * verification or review"), `08` (the Product Trust Passport keeps three axes separate), `02` (no
 * aggregate score), `18` (a label is always present; meaning never carried by colour), `09`,
 * `11` and DEC-010 (composition is server-side).
 *
 * THIS SCREEN COMPOSES NOTHING
 * Every label, every sentence and every "not recorded" arrived composed. The component lays out
 * what it was sent - including which fields exist, because that is the difference between a
 * medicine and a shampoo and it is not a client's decision.
 *
 * WHAT IS NOT SETTLED COMES FIRST
 * Above the details rather than under them. Exit criterion 2 is that a person can understand
 * which items need verification or review, and a list of outstanding things at the foot of a
 * screen is one most people never reach.
 *
 * QUOTED TEXT IS RENDERED AS A QUOTATION
 * Written directions and a household's own notes are somebody else's words. `09` forbids Kynviora
 * telling anybody how to take a medicine, and rendering prescribed directions in the same voice
 * as Kynviora's own copy is how that rule quietly fails on a screen.
 */

import { View, Text, StyleSheet } from 'react-native';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  type ScreenState as ScreenStateKind,
} from '@kynviora/presentation';
import type { ItemDetailScreenView, ItemFieldResponse } from '@kynviora/contracts';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import { StatusChip } from '@/components/StatusChip';

export interface ItemDetailProps {
  readonly view: ItemDetailScreenView | null;
  readonly state: ScreenStateKind;
  readonly onClose: () => void;
  /**
   * Opens the editing screen.
   *
   * Offered only where the server said this caller may change the item - absent rather than
   * disabled (DEC-045). A caregiver who may read a medicine and not change it sees a screen with
   * no control, not a greyed-out one telling them what they are not trusted with.
   */
  readonly onEdit?: () => void;
}

function FieldRow({ field }: { readonly field: ItemFieldResponse }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{field.label}</Text>
      {field.value === null ? (
        // Kept as a row rather than dropped. A dropped row reads as "not relevant to this item";
        // this one says nobody has entered it, which is what is true.
        <Text style={styles.absent}>{field.absentNote}</Text>
      ) : (
        <Text style={field.quoted ? styles.quoted : styles.body}>{field.value}</Text>
      )}
    </View>
  );
}

export function ItemDetail({ view, state, onClose, onEdit }: ItemDetailProps) {
  return (
    <View style={styles.container}>
      <ScreenState state={state} />

      {view === null ? null : (
        <>
          <Text accessibilityRole="header" style={styles.heading}>
            {view.displayName}
          </Text>
          {view.brand === null ? null : <Text style={styles.brand}>{view.brand}</Text>}

          {/* An item somebody has finished with says so, and says Kynviora will stop asking. */}
          {view.lifecycleNote === null ? null : (
            <Text style={styles.notice}>{view.lifecycleNote}</Text>
          )}

          {/* Exit criterion 2, above the details rather than under them. */}
          <View style={styles.block}>
            <Text accessibilityRole="header" style={styles.subheading}>
              What is not settled
            </Text>
            {view.attention.reasons.length === 0 ? (
              <Text style={styles.body}>{view.attention.settledNote}</Text>
            ) : (
              view.attention.reasons.map((reason) => (
                <View key={reason.reason} style={styles.field}>
                  <Text style={styles.body}>{reason.label}</Text>
                  {/* What would settle it. Always about the record, never about the medicine. */}
                  <Text style={styles.caption}>{reason.nextStep}</Text>
                </View>
              ))
            )}
            {view.attention.undescribedNote === null ? null : (
              <Text style={styles.caption}>{view.attention.undescribedNote}</Text>
            )}
          </View>

          {/* Three chips, never one. `02` forbids the aggregate and `08` keeps the axes apart. */}
          <View style={styles.block}>
            <Text accessibilityRole="header" style={styles.subheading}>
              How well Kynviora knows this
            </Text>
            <View style={styles.chips}>
              {/* A presentation this build could not read is absent rather than a blank chip,
                  which on this screen would read as a state nobody assigned. */}
              {view.identity === null ? null : (
                <StatusChip presentation={view.identity} showDescription />
              )}
              {view.formulation === null ? null : (
                <StatusChip presentation={view.formulation} showDescription />
              )}
              {view.batch === null ? null : (
                <StatusChip presentation={view.batch} showDescription />
              )}
            </View>
            <Text style={styles.caption}>{view.verificationNote}</Text>
          </View>

          {/* The category's own fields. Which ones exist is the server's answer, and it is the
              whole of exit criterion 1 on this screen. */}
          <View style={styles.block}>
            <Text accessibilityRole="header" style={styles.subheading}>
              {view.categoryHeading}
            </Text>
            {view.categoryFields.map((field) => (
              <FieldRow key={field.label} field={field} />
            ))}
          </View>

          <View style={styles.block}>
            <Text accessibilityRole="header" style={styles.subheading}>
              On the record
            </Text>
            {view.sharedFields.map((field) => (
              <FieldRow key={field.label} field={field} />
            ))}
          </View>
        </>
      )}

      {/* Absent where the caller may not change the item, and absent where the detail did not
          arrive - a control offered over nothing would open a form with no version to send. */}
      {view !== null && view.mayEdit && onEdit !== undefined ? (
        <PrimaryButton label="Change what is recorded" variant="secondary" onPress={onEdit} />
      ) : null}

      <PrimaryButton label="Back to the shelf" variant="secondary" onPress={onClose} />
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
  subheading: {
    fontSize: FONT_SIZE.body,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  brand: {
    fontSize: FONT_SIZE.caption,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
  block: {
    gap: SPACING.xs,
    padding: SPACING.md,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
    backgroundColor: LIGHT_THEME.surface.background,
  },
  chips: { gap: SPACING.xs },
  field: { gap: 2, paddingVertical: SPACING.xs },
  fieldLabel: {
    fontSize: FONT_SIZE.caption,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  body: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surface.foreground,
  },
  // Somebody else's words. Set apart so a prescription instruction never reads as Kynviora's.
  quoted: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surface.foreground,
    fontStyle: 'italic',
    paddingLeft: SPACING.sm,
    borderLeftWidth: 2,
    borderLeftColor: LIGHT_THEME.surface.border,
  },
  absent: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
  caption: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
  notice: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surface.foreground,
    padding: SPACING.md,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.informational.border,
    backgroundColor: LIGHT_THEME.informational.background,
  },
});
