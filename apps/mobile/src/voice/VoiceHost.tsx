/**
 * Where Voice Mode is drawn, and the control that opens it.
 *
 * Spec references: `06` (five destinations; scan/add and now Voice Mode are actions available
 * from them, never a sixth destination), `18` (no swipe-only or long-press-only core action; a
 * control has a name; 48dp minimum), `12`. DEC-136.
 *
 * WHY AN OVERLAY AND NOT A ROUTE
 * The same argument every sheet in this app makes. `06` fixes the destinations, and adding a
 * sixth for Voice Mode would take a slot from Today, Shelf, Safety, Care or You - none of which
 * `06` will give up. It is drawn over the whole app because a conversation is not about one
 * screen, and it keeps its transcript when closed, because somebody who put the phone down
 * mid-sentence has to come back to what was said.
 *
 * WHY THE CONTROL IS A FULL-WIDTH BAR AND NOT AN ICON
 * `18`'s audience. An icon in a header is small, unlabelled and in the corner furthest from a
 * thumb. This is the width of the screen, carries the word "Talk", sits in the same place on
 * every destination, and is a plain tap.
 */

import { View, StyleSheet } from 'react-native';
import { MIN_TOUCH_TARGET_DP, SPACING, type Theme } from '@kynviora/presentation';
import { PrimaryButton } from '@/components/PrimaryButton';
import { useThemedStyles } from '@/theme/ThemeProvider';
import { useVoice } from './VoiceProvider';
import { VoiceScreen } from './VoiceScreen';
import type { ReactNode } from 'react';

/**
 * Draw the app, or draw Voice Mode over it.
 *
 * Replacement rather than a layer on top: a transparent overlay leaves the app underneath
 * reachable by a screen reader, so somebody navigating by swipe would walk out of the
 * conversation into a screen they cannot see.
 */
export function VoiceHost({ children }: { readonly children: ReactNode }) {
  const { isOpen, close } = useVoice();
  return isOpen ? <VoiceScreen onClose={close} /> : <>{children}</>;
}

/** The control. Rendered by the five destinations, in the same place on each. */
export function VoiceBar() {
  const styles = useThemedStyles(makeStyles);
  const { open, canListen, session } = useVoice();
  const held = session.transcript.length > 0;

  return (
    <View style={styles.bar}>
      <PrimaryButton
        // The label says what happens, and it changes when there is a conversation to come back
        // to - `18` wants a control to say what it does rather than where it goes.
        label={held ? 'Back to the conversation' : 'Talk to Kynviora'}
        variant="secondary"
        accessibilityHint={
          canListen
            ? 'Ask Kynviora to do something out loud.'
            : 'Ask Kynviora to do something. This phone cannot listen yet, so you type instead.'
        }
        style={styles.button}
        onPress={open}
      />
    </View>
  );
}

const makeStyles = (_theme: Theme) =>
  StyleSheet.create({
    bar: { marginBottom: SPACING.xs },
    button: { minHeight: MIN_TOUCH_TARGET_DP + SPACING.sm },
  });
