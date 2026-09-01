/**
 * One alert, explained.
 *
 * Spec references: `04` Phase 7.3 (affected person and exact item, match confidence, reason for
 * match, evidence level, urgency, jurisdiction/source/date, source reference where allowed, next
 * action, limitations, report-incorrect - and "the UI reveals what is known versus inferred"),
 * `09`, `18` (the eight-part order; a label always present; meaning never carried by colour),
 * `23` D-005, `11` and DEC-010 (safety composition is server-side).
 *
 * THIS SCREEN COMPOSES NOTHING
 * Every sentence on it came from the server. The approved eight-part message, the withheld-source
 * explanation, the coverage statement and the per-fact origin labels are all decided in
 * `@kynviora/presentation` and assembled by the route. `11` puts safety composition server-side
 * so that approved wording is not carried in every shipped build, and this component is the shape
 * that rule takes on a screen: it lays out and it does not write.
 *
 * WHAT IS KNOWN AND WHAT WAS WORKED OUT
 * The facts are rendered in one list, each with the sentence saying where it came from, and there
 * is deliberately no visual grouping into "known" and "inferred". Two blocks would invite reading
 * one and skipping the other, and the four origins are not two: a batch number read off the pack
 * and one somebody typed are both "known" and are not the same evidence.
 *
 * THE ORDER IS THE SERVER'S
 * The message parts arrive in `18`'s prescribed order and are rendered in the order they arrive.
 * A component that re-ordered them - putting the recommended step first, say - would be making a
 * content decision about a safety message.
 */

import { View, Text, StyleSheet } from 'react-native';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  type ScreenState as ScreenStateKind,
} from '@kynviora/presentation';
import type { AlertDetailScreenView } from '@kynviora/contracts';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import { StatusChip } from '@/components/StatusChip';

export interface AlertDetailProps {
  readonly view: AlertDetailScreenView | null;
  readonly state: ScreenStateKind;
  /** `null` while a report is in flight or when the server offered no action. */
  readonly onReportIncorrect: (() => void) | null;
  readonly reporting: boolean;
  readonly reportMessage: string | null;
  /** Opens the Safety Receipt (`04` Phase 7.6) for this alert. */
  readonly onOpenReceipt: () => void;
  readonly onClose: () => void;
}

export function AlertDetail({
  view,
  state,
  onReportIncorrect,
  reporting,
  reportMessage,
  onOpenReceipt,
  onClose,
}: AlertDetailProps) {
  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        Why you are seeing this
      </Text>

      <ScreenState state={state} />

      {view === null ? null : (
        <>
          {/* A withdrawn alert must never read as live (`19`). In practice the server refuses to
              return one at all, and this branch is what a receipt history will render. */}
          {view.withdrawnNotice === null ? null : (
            <Text style={styles.notice}>{view.withdrawnNotice}</Text>
          )}

          {/* Part of this alert is being kept from this session rather than missing. DEC-026's
              shape: the withholding is reported, not shown as a blank. */}
          {view.withheldNotice === null ? null : (
            <Text style={styles.notice}>{view.withheldNotice}</Text>
          )}

          {/* Three chips, never merged into one. `23` D-005 and Phase 7.1's second criterion. A
              presentation the client could not read is absent rather than rendered blank. */}
          <View style={styles.chips}>
            {view.urgency === null ? null : (
              <StatusChip presentation={view.urgency} showDescription />
            )}
            {view.evidence === null ? null : (
              <StatusChip presentation={view.evidence} showDescription />
            )}
            {view.matchConfidence === null ? null : (
              <StatusChip presentation={view.matchConfidence} showDescription />
            )}
          </View>

          {/* The approved message, in the order it arrived. */}
          {view.message === null
            ? null
            : view.message.map((part, index) => (
                <Text key={`part-${String(index)}`} style={styles.body}>
                  {part}
                </Text>
              ))}

          {/* No approved wording applies. Said plainly rather than filled with a generic
              sentence about somebody's medicine that no reviewer wrote. */}
          {view.unexplainable === null ? null : (
            <View style={styles.block}>
              <Text accessibilityRole="header" style={styles.subheading}>
                {view.unexplainable.heading}
              </Text>
              <Text style={styles.body}>{view.unexplainable.body}</Text>
            </View>
          )}

          {/* Why it matched. Reasons this build has no wording for are counted, not shown as
              codes - the note says how many. */}
          {view.reasons.length === 0 ? null : (
            <View style={styles.block}>
              <Text accessibilityRole="header" style={styles.subheading}>
                Why it matched
              </Text>
              {view.reasons.map((reason, index) => (
                <Text key={`reason-${String(index)}`} style={styles.body}>
                  {reason}
                </Text>
              ))}
            </View>
          )}
          {view.undescribedReasonNote === null ? null : (
            <Text style={styles.caption}>{view.undescribedReasonNote}</Text>
          )}

          {/* The facts, each with its origin. This is Phase 7.3's second exit criterion on the
              screen: no line without a sentence saying where it came from. */}
          <View style={styles.block}>
            <Text accessibilityRole="header" style={styles.subheading}>
              What this rests on
            </Text>
            <Text style={styles.caption}>{view.basisNote}</Text>
            {view.facts.map((fact) => (
              <View key={fact.label} style={styles.fact}>
                <Text style={styles.factLabel}>{fact.label}</Text>
                {/* A value Kynviora does not have, or is withholding, keeps its row. A dropped
                    row reads as "not relevant"; the sentence beneath says which it is. */}
                <Text style={styles.body}>{fact.value ?? '—'}</Text>
                <Text style={styles.caption}>{fact.basisText}</Text>
              </View>
            ))}
            {view.unlabelledFactNote === null ? null : (
              <Text style={styles.caption}>{view.unlabelledFactNote}</Text>
            )}
          </View>

          {/* Source, date and - where the licence review allows it - the reference. */}
          <View style={styles.block}>
            <Text accessibilityRole="header" style={styles.subheading}>
              Where this came from
            </Text>
            <Text style={styles.body}>{view.source.summary}</Text>
            {view.source.reference === null ? null : (
              <Text style={styles.body}>Reference: {view.source.reference}</Text>
            )}
            {view.source.referenceWithheldBecause === null ? null : (
              <Text style={styles.caption}>{view.source.referenceWithheldBecause}</Text>
            )}
            {view.source.attribution === null ? null : (
              <Text style={styles.caption}>{view.source.attribution}</Text>
            )}
          </View>

          {/* On screen in every state (`09`). An absence of a finding is not reassurance. */}
          <Text style={styles.caption}>{view.coverageStatement}</Text>

          {/* The correction action, or the sentence saying why it is not offered. Absent rather
              than disabled (DEC-045). */}
          {view.actions.map((action) => (
            <View key={action.action} style={styles.block}>
              <Text style={styles.caption}>{action.explanation}</Text>
              <PrimaryButton
                label={action.label}
                variant="secondary"
                disabled={reporting || onReportIncorrect === null}
                onPress={() => {
                  onReportIncorrect?.();
                }}
              />
            </View>
          ))}
          {view.actionsUnavailableBecause === null ? null : (
            <Text style={styles.caption}>{view.actionsUnavailableBecause}</Text>
          )}
          {reportMessage === null ? null : <Text style={styles.notice}>{reportMessage}</Text>}

          {/* Phase 7.6 opens from here rather than from the inbox. What somebody did about an
              alert is a fact about that alert, and a separate list of receipts would be a second
              place to look for the same thing. Always offered, including where nothing has been
              recorded: the receipt is also where the versions and the limits live. */}
          <View style={styles.block}>
            <Text style={styles.caption}>
              What you have recorded about this alert, what Kynviora has corrected since, and the
              versions it used.
            </Text>
            <PrimaryButton
              label="What you did about this"
              variant="secondary"
              onPress={onOpenReceipt}
            />
          </View>
        </>
      )}

      <PrimaryButton label="Back to Safety" variant="secondary" onPress={onClose} />
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
  block: {
    gap: SPACING.xs,
    padding: SPACING.md,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
    backgroundColor: LIGHT_THEME.surface.background,
  },
  chips: { gap: SPACING.sm },
  fact: { gap: 2, paddingVertical: SPACING.xs },
  factLabel: {
    fontSize: FONT_SIZE.caption,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  body: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surface.foreground,
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
