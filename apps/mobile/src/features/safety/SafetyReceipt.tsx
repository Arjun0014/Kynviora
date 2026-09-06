/**
 * What you did about an alert, and what Kynviora still cannot settle.
 *
 * Spec references: `04` Phase 7.6 (the resolution vocabulary; a versioned receipt carrying the
 * alert, the source and rule version, the action and later corrections; "resolution does not erase
 * historical assessment"; "corrections remain visible and auditable"), `09`, `10`, `18`, `02`,
 * `11` and DEC-010 (safety composition is server-side), DEC-075, DEC-076.
 *
 * THIS SCREEN COMPOSES NOTHING EITHER
 * Every sentence came from the server, including the uncertainties and the permanence note. The
 * one thing assembled on the client is the list of controls, which is a control list rather than a
 * statement about this person's alert.
 *
 * NOTHING HERE IS PRESELECTED AND NOTHING IS RECOMMENDED
 * Seven controls, one weight, in the vocabulary's order with actions before feedback. No option
 * carries a primary variant, a default, or a badge. Which of these somebody did is a fact about
 * them, and a preselected control collects answers from people who pressed the one already
 * pressed - the reconciliation screen's rule (DEC-030) and the reviewer console's (DEC-069).
 *
 * THERE IS NO COMPLETION AND NO PROGRESS
 * No tick, no "resolved" banner, no count of how many alerts a household has dealt with. An alert
 * somebody reviewed is not finished with, and `02` names alarm-optimised design as an anti-feature
 * - a completion meter is the cheerful version of the same thing.
 *
 * WHAT IS UNCERTAIN IS NOT AT THE BOTTOM
 * The uncertainties sit above the controls rather than below them, because a receipt reads as
 * settled precisely because somebody acted on it, and `10` asks for the limits beside the finding
 * rather than after it.
 */

import { View, Text, StyleSheet } from 'react-native';
import {
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  type ScreenState as ScreenStateKind,
  type Theme,
} from '@kynviora/presentation';
import type { ReceiptOptionView, SafetyReceiptScreenView } from '@kynviora/contracts';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import { useThemedStyles } from '@/theme/ThemeProvider';

export interface SafetyReceiptProps {
  readonly view: SafetyReceiptScreenView | null;
  readonly state: ScreenStateKind;
  /** `null` while a resolution is in flight. Absent rather than disabled where nothing is offered. */
  readonly onRecord: ((resolution: string) => void) | null;
  readonly recording: boolean;
  readonly recordMessage: string | null;
  readonly onClose: () => void;
}

function OptionGroup({
  heading,
  options,
  onRecord,
  recording,
}: {
  readonly heading: string;
  readonly options: readonly ReceiptOptionView[];
  readonly onRecord: ((resolution: string) => void) | null;
  readonly recording: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  if (options.length === 0) return null;
  return (
    <View style={styles.block}>
      <Text accessibilityRole="header" style={styles.subheading}>
        {heading}
      </Text>
      {options.map((option) => (
        <View key={option.resolution} style={styles.option}>
          {/* The description first, then the control. What recording something does *not* do is
              the half a person needs before they press it, not after. */}
          <Text style={styles.caption}>{option.description}</Text>
          <PrimaryButton
            label={option.label}
            // Every control is the same weight. None of these is the expected answer.
            variant="secondary"
            // The visible label is already the accessible name; this is the outcome sentence,
            // which is what `18` asks for on a high-impact action.
            accessibilityHint={option.accessibilityLabel}
            disabled={recording || onRecord === null}
            onPress={() => {
              onRecord?.(option.resolution);
            }}
          />
        </View>
      ))}
    </View>
  );
}

export function SafetyReceipt({
  view,
  state,
  onRecord,
  recording,
  recordMessage,
  onClose,
}: SafetyReceiptProps) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        What you did about this
      </Text>

      <ScreenState state={state} />

      {view === null ? null : (
        <>
          {/* On screen in every state, including the empty one. A person marking something "not
              applicable" reasonably expects it to go away, and this is where that expectation is
              corrected before they act on it rather than after. */}
          <Text style={styles.notice}>{view.permanenceNote}</Text>

          {/* Kynviora corrected something after they recorded what they did. Above everything
              else on the screen, because it changes how to read the rest of it. */}
          {view.correctedSinceNotice === null ? null : (
            <Text style={styles.notice}>{view.correctedSinceNotice}</Text>
          )}

          <View style={styles.block}>
            <Text accessibilityRole="header" style={styles.subheading}>
              What stands now
            </Text>
            {view.current === null ? (
              <Text style={styles.body}>{view.emptyMessage}</Text>
            ) : (
              <>
                <Text style={styles.body}>{view.current.label}</Text>
                <Text style={styles.caption}>{view.current.description}</Text>
                <Text style={styles.caption}>Recorded {view.current.recordedAt}</Text>
                {/* Their own words, kept as written. Never summarised and never shown to a
                    caregiver who may not read notes. */}
                {view.current.note === null ? null : (
                  <Text style={styles.body}>{view.current.note}</Text>
                )}
              </>
            )}
            {view.undescribedResolutionNote === null ? null : (
              <Text style={styles.caption}>{view.undescribedResolutionNote}</Text>
            )}
          </View>

          {/* The chain, from the append-only log. One receipt row is what stands; this is what
              happened, and nobody can rewrite it (DEC-075). No actor on any line (DEC-076). */}
          {view.history.length === 0 ? null : (
            <View style={styles.block}>
              <Text accessibilityRole="header" style={styles.subheading}>
                Everything you have recorded
              </Text>
              {view.history.map((line, index) => (
                <View key={`history-${String(index)}`} style={styles.entry}>
                  <Text style={styles.body}>{line.label}</Text>
                  <Text style={styles.caption}>{line.recordedAt}</Text>
                  {line.replacedPreviousNote === null ? null : (
                    <Text style={styles.caption}>{line.replacedPreviousNote}</Text>
                  )}
                </View>
              ))}
              {view.undescribedHistoryNote === null ? null : (
                <Text style={styles.caption}>{view.undescribedHistoryNote}</Text>
              )}
            </View>
          )}

          {/* Corrections beside what the person recorded, never instead of it. Exit criterion 2
              on the screen. */}
          {view.corrections.length === 0 ? null : (
            <View style={styles.block}>
              <Text accessibilityRole="header" style={styles.subheading}>
                What Kynviora corrected
              </Text>
              {view.corrections.map((correction, index) => (
                <View key={`correction-${String(index)}`} style={styles.entry}>
                  <Text style={styles.body}>{correction.heading}</Text>
                  <Text style={styles.caption}>{correction.reason}</Text>
                  <Text style={styles.caption}>{correction.recordedAt}</Text>
                </View>
              ))}
            </View>
          )}

          {/* What this receipt does not settle. Above the controls, not below them. */}
          {view.uncertainties.length === 0 ? null : (
            <View style={styles.block}>
              <Text accessibilityRole="header" style={styles.subheading}>
                What is still not settled
              </Text>
              {view.uncertainties.map((sentence, index) => (
                <Text key={`uncertainty-${String(index)}`} style={styles.body}>
                  {sentence}
                </Text>
              ))}
            </View>
          )}

          <OptionGroup
            heading="Record what you did"
            options={view.actionOptions}
            onRecord={onRecord}
            recording={recording}
          />
          <OptionGroup
            heading="Tell Kynviora it got something wrong"
            options={view.feedbackOptions}
            onRecord={onRecord}
            recording={recording}
          />
          {recordMessage === null ? null : <Text style={styles.notice}>{recordMessage}</Text>}

          {/* The versions, last, because they are what somebody reads out at a pharmacy counter
              rather than what they came here for. */}
          <View style={styles.block}>
            <Text accessibilityRole="header" style={styles.subheading}>
              {view.basis.heading}
            </Text>
            <Text style={styles.caption}>{view.basis.note}</Text>
            {view.basis.rule === null ? (
              <Text style={styles.caption}>{view.basis.ruleUnavailableNote}</Text>
            ) : (
              <Text style={styles.body}>{view.basis.rule}</Text>
            )}
            <Text style={styles.caption}>Rule version {view.basis.ruleVersionId}</Text>
            {view.basis.regulatoryRuleVersionId === null ? null : (
              <Text style={styles.caption}>
                Regulatory version {view.basis.regulatoryRuleVersionId}
              </Text>
            )}
            {/* Three gradings, stated separately and never merged (`23` D-005). */}
            <Text style={styles.body}>{view.basis.evidenceLabel}</Text>
            <Text style={styles.caption}>{view.basis.evidenceDescription}</Text>
            <Text style={styles.body}>{view.basis.confidenceLabel}</Text>
            <Text style={styles.caption}>{view.basis.confidenceDescription}</Text>
            <Text style={styles.caption}>Urgency when raised: {view.basis.urgencyLabel}</Text>
            <Text style={styles.caption}>Assessed {view.basis.assessedOn}</Text>
            <Text style={styles.caption}>Alert raised {view.basis.alertRaisedOn}</Text>
          </View>

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
        </>
      )}

      <PrimaryButton label="Back to the alert" variant="secondary" onPress={onClose} />
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { gap: SPACING.md },
    heading: {
      fontSize: FONT_SIZE.title,
      fontWeight: '600',
      color: theme.surface.foreground,
    },
    subheading: {
      fontSize: FONT_SIZE.body,
      fontWeight: '600',
      color: theme.surface.foreground,
    },
    block: {
      gap: SPACING.xs,
      padding: SPACING.md,
      borderWidth: 1,
      borderRadius: SPACING.sm,
      borderColor: theme.surface.border,
      backgroundColor: theme.surface.background,
    },
    entry: { gap: 2, paddingVertical: SPACING.xs },
    option: { gap: SPACING.xs, paddingVertical: SPACING.xs },
    body: {
      fontSize: FONT_SIZE.body,
      lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.surface.foreground,
    },
    caption: {
      fontSize: FONT_SIZE.caption,
      lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.surfaceMuted.foreground,
    },
    notice: {
      fontSize: FONT_SIZE.body,
      lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.surface.foreground,
      padding: SPACING.md,
      borderWidth: 1,
      borderRadius: SPACING.sm,
      borderColor: theme.informational.border,
      backgroundColor: theme.informational.background,
    },
  });
