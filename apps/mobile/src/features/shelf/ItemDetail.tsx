/**
 * One item on the shelf, and what is not settled about it.
 *
 * Spec references: `04` Phase 2.1 (item detail; "medicines and personal-care items coexist
 * without either being reduced to a generic note"; "a user can understand which items need
 * verification or review"), `08` (the Product Trust Passport keeps three axes separate), `02` (no
 * aggregate score), `18` (a label is always present; meaning never carried by colour), `09`,
 * `11` and DEC-010 (composition is server-side), DEC-130.
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
 * WHY THE THREE CHIPS SIT IN THE HEADER CARD RATHER THAN IN THEIR OWN SECTION
 * They qualify the name, and a qualification that travels with the fact it qualifies is the one
 * rule progressive disclosure must not break (`docs/design/DESIGN_SYSTEM.md`, section 10). The
 * longer descriptions still live in their own card lower down, which is the disclosure; what is
 * beside the name is the part somebody must not be able to read past.
 *
 * ONE PRIMARY ACTION
 * `18`. "Change what is recorded" is it. Deleting is a `destructive` variant below it, and
 * "Back to the shelf" is a plain secondary - three controls that look like three different
 * degrees of consequence rather than three identical buttons.
 */

import { View, StyleSheet } from 'react-native';
import {
  SPACING,
  ITEM_DELETION_COPY,
  presentShelfCollection,
  shelfMoveControl,
  type ScreenState as ScreenStateKind,
  type Theme,
} from '@kynviora/presentation';
import type { ShelfCollection } from '@kynviora/domain';
import type { ItemDetailScreenView } from '@kynviora/contracts';
import { Card } from '@/components/Card';
import { FieldRow } from '@/components/FieldRow';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import { SectionHeader } from '@/components/SectionHeader';
import { StatusChip } from '@/components/StatusChip';
import { Typography } from '@/components/Typography';
import { useThemedStyles } from '@/theme/ThemeProvider';

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
  /**
   * Opens the deletion confirmation.
   *
   * Offered only where the server said this caller owns the profile - which is a different
   * question from {@link ItemDetailProps.onEdit}, and deliberately so. No caregiver capability
   * authorises deletion (docs/RETENTION.md section 2), so a caregiver holding every capability
   * there is sees the edit control and not this one.
   */
  readonly onDelete?: () => void;
  /**
   * Moves the item to the shelf's other collection (`0033`, DEC-160).
   *
   * The destination is not a parameter: {@link shelfMoveControl} decides it from where the item
   * is, so the label a person read and the write that happens cannot describe different moves.
   * Offered only where the same caller may edit - it is a change to the record and takes the same
   * version precondition - and only where the move exists at all, which for a medicine it does
   * not.
   */
  readonly onMove?: (to: ShelfCollection) => void;
  /**
   * What happened to the last move, or `null`.
   *
   * A sentence rather than a state, and drawn beside the control that produced it: a move is one
   * tap with no form behind it, so a refusal shown anywhere else would be a message about
   * something the person has already stopped looking at.
   */
  readonly moveNote?: string | null;
}

export function ItemDetail({
  view,
  state,
  onClose,
  onEdit,
  onDelete,
  onMove,
  moveNote,
}: ItemDetailProps) {
  const styles = useThemedStyles(makeStyles);
  const move = view === null ? null : shelfMoveControl(view.shelfCollection, view.mayBeConsidered);
  return (
    <View style={styles.container}>
      <ScreenState state={state} />

      {view === null ? null : (
        <>
          <Card>
            <Typography role="title" heading>
              {view.displayName}
            </Typography>
            {view.brand === null ? null : (
              <Typography role="caption" colour="secondary">
                {view.brand}
              </Typography>
            )}

            {/* Three chips, never one. `02` forbids the aggregate and `08` keeps the axes apart.
                Here they are the short form, beside the name they qualify. */}
            <View style={styles.chips}>
              {/* A presentation this build could not read is absent rather than a blank chip,
                  which on this screen would read as a state nobody assigned. */}
              {view.identity === null ? null : <StatusChip presentation={view.identity} />}
              {view.formulation === null ? null : <StatusChip presentation={view.formulation} />}
              {view.batch === null ? null : <StatusChip presentation={view.batch} />}
            </View>
          </Card>

          {/* Which collection it is in, and the way out of it.

              It sits with the name rather than beside the primary action because it qualifies
              what the whole screen is about: everything below reads differently for something a
              person is thinking about than for something they take. The sentence is on screen in
              both collections - an item in Considering that only said so by the absence of a
              control would be an absence nobody can read (`18`).

              The move is a change to the record like any other, so it is offered only where this
              caller may change it, and the write carries the same version precondition. */}
          <Card>
            <Typography role="label">
              {presentShelfCollection(view.shelfCollection).label}
            </Typography>
            <Typography role="caption" colour="secondary">
              {presentShelfCollection(view.shelfCollection).meaning}
            </Typography>
            {move === null || onMove === undefined || !view.mayEdit ? null : (
              <>
                <Typography role="caption" colour="secondary">
                  {move.note}
                </Typography>
                <PrimaryButton
                  label={move.label}
                  variant="secondary"
                  onPress={() => {
                    onMove(move.to);
                  }}
                />
              </>
            )}
            {moveNote === null || moveNote === undefined ? null : (
              <Typography role="body">{moveNote}</Typography>
            )}
          </Card>

          {/* An item somebody has finished with says so, and says Kynviora will stop asking. */}
          {view.lifecycleNote === null ? null : (
            <Card tone="informational">
              <Typography role="body" colour="informational">
                {view.lifecycleNote}
              </Typography>
            </Card>
          )}

          {/* Exit criterion 2, above the details rather than under them. */}
          <SectionHeader
            title="What is not settled"
            explanation="Things that would make what Kynviora can say about this more exact."
          />
          <Card>
            {view.attention.reasons.length === 0 ? (
              <Typography role="body">{view.attention.settledNote}</Typography>
            ) : (
              view.attention.reasons.map((reason) => (
                <View key={reason.reason} style={styles.reason}>
                  <Typography role="body">{reason.label}</Typography>
                  {/* What would settle it. Always about the record, never about the medicine. */}
                  <Typography role="caption" colour="secondary">
                    {reason.nextStep}
                  </Typography>
                </View>
              ))
            )}
            {view.attention.undescribedNote === null ? null : (
              <Typography role="caption" colour="secondary">
                {view.attention.undescribedNote}
              </Typography>
            )}
          </Card>

          <SectionHeader title="How well Kynviora knows this" />
          <Card>
            <View style={styles.chipColumn}>
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
            <Typography role="caption" colour="secondary">
              {view.verificationNote}
            </Typography>
          </Card>

          {/* The category's own fields. Which ones exist is the server's answer, and it is the
              whole of exit criterion 1 on this screen. */}
          <SectionHeader title={view.categoryHeading} />
          <Card>
            {view.categoryFields.map((field) => (
              <FieldRow
                key={field.label}
                label={field.label}
                value={field.value}
                absent={field.absentNote}
                quoted={field.quoted}
              />
            ))}
          </Card>

          <SectionHeader title="On the record" />
          <Card>
            {view.sharedFields.map((field) => (
              <FieldRow
                key={field.label}
                label={field.label}
                value={field.value}
                absent={field.absentNote}
                quoted={field.quoted}
              />
            ))}
          </Card>
        </>
      )}

      <View style={styles.actions}>
        {/* Absent where the caller may not change the item, and absent where the detail did not
            arrive - a control offered over nothing would open a form with no version to send. */}
        {view !== null && view.mayEdit && onEdit !== undefined ? (
          <PrimaryButton label="Change what is recorded" onPress={onEdit} />
        ) : null}

        <PrimaryButton label="Back to the shelf" variant="secondary" onPress={onClose} />

        {/* Below Back, and last on the screen. `18` puts the destructive action where it is
            hardest to reach by accident on a screen somebody is scrolling, and the `destructive`
            variant is the one place a semantic tone is on a control - because what it does is
            what that tone means. Withheld rather than disabled where the caller does not own the
            profile (DEC-045), which for this control is every caregiver however much else they
            may do. */}
        {view !== null && view.mayDelete && onDelete !== undefined ? (
          <PrimaryButton
            label={ITEM_DELETION_COPY.openLabel}
            variant="destructive"
            onPress={onDelete}
          />
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (_theme: Theme) =>
  StyleSheet.create({
    container: { gap: SPACING.md },
    chips: { gap: SPACING.xs, marginTop: SPACING.xs },
    chipColumn: { gap: SPACING.sm },
    reason: { gap: SPACING.xxs, paddingVertical: SPACING.xs },
    // The actions are one group with a little air above them, so the last card does not read as
    // the thing the first button is about.
    actions: { gap: SPACING.sm, marginTop: SPACING.sm },
  });
