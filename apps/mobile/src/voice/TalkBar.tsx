/**
 * The persistent Talk to Kynviora bar, and the panel that rises above it.
 *
 * Spec references: `18` (meaning never carried by colour alone; a control says what it does;
 * 48dp; system font scaling; reduce-motion is honoured), `06`, `17`, DEC-130, DEC-136, DEC-156,
 * DEC-157.
 *
 * WHERE IT LIVES
 * In `Screen`'s `footer` slot, which is **outside** the scroll view and immediately above the
 * bottom navigation - so it is in the same place on every destination and does not move while the
 * content does. That is what "persistent" means here, and it is the thing the per-screen control
 * it replaced could not do: that one scrolled away with the first card.
 *
 * The navigator would have been the other place to draw it, and it is not, for a reason worth
 * recording: expo-router's `href: null` is what keeps the Coverage Center reachable and out of the
 * five slots (DEC-151), and a hand-rolled `tabBar` would have had to reimplement that filtering
 * along with the safe-area handling and the accessibility roles that come with the real one.
 * A slot on the frame gets the same placement and reimplements nothing.
 *
 * It leaves for camera capture, an open sheet, selection mode and a critical confirmation - the
 * three the design language names and the one `18` implies. A screen expresses that by declaring
 * it, and a screen with no bar at all simply passes no footer.
 *
 * WHAT IT SAYS AND WHAT IT ANIMATES
 * The label is the state, in words, always. The animation is a pulse behind the label, driven only
 * by `live`, and it carries nothing: with reduce-motion on, or with the pulse removed entirely,
 * every state is still fully legible. That is the design language's rule and `18`'s.
 *
 * THE PANEL IS NOT A THREAD
 * Tapping the bar does not open a chatbot. The current screen stays visible, a panel rises above
 * the bar carrying only what the screen cannot - the last thing said, the phrasings this route
 * offers, a confirmation when one is armed - and the **result lands in the UI**. Nothing
 * accumulates: the transcript lives in the full Voice Mode screen, which is still one tap away and
 * is still the accessible record.
 *
 * THE FOOTER IS THE POINT OF THE FOOTER
 * It shows the exact context snapshot: route, profile, what is focused, how many things are
 * selected, how many actions were offered. That is the whole of what a request would carry, which
 * is a claim that can be made honestly only because `ScreenContext` has no field content could
 * arrive in (DEC-132).
 */

import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { MIN_TOUCH_TARGET_DP, RADIUS, SPACING, type Theme } from '@kynviora/presentation';
import { talkBarIsVisible, talkBarPresentation, talkBarStateFor } from '@kynviora/agent';
import { Typography } from '@/components/Typography';
import { PrimaryButton } from '@/components/PrimaryButton';
import { useTheme, useThemeContext, useThemedStyles } from '@/theme/ThemeProvider';
import { useVoice } from './VoiceProvider';
import { useScreenContext } from './ScreenContextProvider';

/** How long one breath of the listening pulse takes. Slow, because it is not an alarm. */
const PULSE_MS = 1400;

export function TalkBar() {
  const styles = useThemedStyles(makeStyles);
  const theme = useTheme();
  const { reduceMotion } = useThemeContext();
  const { session, open, phrasings, contextSummary, runScreenAction, canListen } = useVoice();
  const screen = useScreenContext();
  const [panelOpen, setPanelOpen] = useState(false);

  const state = talkBarStateFor(session);
  const presentation = talkBarPresentation(state);
  const tone = theme[presentation.tone];

  const visible = talkBarIsVisible({
    capturing: screen.capturing,
    sheetOpen: screen.sheetOpen,
    selecting: screen.selecting,
    confirming: screen.confirming,
  });

  // The last thing Kynviora said, which is what the panel shows instead of a history. One line,
  // because the panel is not a thread - the full transcript is in Voice Mode.
  const lastSpoken = [...session.transcript].reverse().find((e) => e.speaker === 'KYNVIORA');

  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // Reduce-motion collapses it to zero rather than slowing it down. `18` treats motion as an
    // accessibility setting, and a slower pulse is still a pulse.
    if (!presentation.live || reduceMotion) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: PULSE_MS / 2, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: PULSE_MS / 2, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [presentation.live, reduceMotion, pulse]);

  if (!visible) return null;

  return (
    <View style={styles.wrapper}>
      {panelOpen ? (
        <View
          style={[
            styles.panel,
            { backgroundColor: theme.raised.background, borderColor: theme.raised.border },
          ]}
        >
          {lastSpoken === undefined ? null : (
            <Typography role="body" colour="secondary">
              {lastSpoken.text}
            </Typography>
          )}

          {/*
            The phrasings this route offers. Not suggestions and not examples - each one is an
            action the screen declared, and saying it back word for word runs it. A screen that
            declared nothing says so rather than showing an empty box.
          */}
          {phrasings.length === 0 ? (
            <Typography role="caption" colour="secondary">
              This screen has nothing Kynviora can change from here.
            </Typography>
          ) : (
            phrasings.map((phrasing, index) => (
              <PrimaryButton
                key={phrasing}
                label={phrasing}
                variant="secondary"
                onPress={() => {
                  const action = screen.snapshot.actions[index];
                  if (action !== undefined) runScreenAction(action.id);
                }}
              />
            ))
          )}

          <PrimaryButton
            label="Open the full conversation"
            variant="secondary"
            onPress={() => {
              setPanelOpen(false);
              open();
            }}
          />

          {/*
            The whole of what would leave the phone, rendered from the same object that would
            carry it. Small, secondary, and never hidden behind a disclosure: a footer somebody has
            to open is one that is not making the claim it is there to make.
          */}
          <Typography role="caption" colour="secondary">
            {`Kynviora is told: ${contextSummary}`}
          </Typography>
        </View>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: panelOpen }}
        // One node, one announcement: the state and what happens next, then what the tap does.
        accessibilityLabel={`${presentation.accessibilityLabel} ${panelOpen ? 'Close.' : 'Open.'}`}
        accessibilityHint={
          canListen
            ? undefined
            : 'This phone cannot listen yet, so you choose or type instead of speaking.'
        }
        onPress={() => {
          setPanelOpen((on) => !on);
        }}
        style={[styles.bar, { backgroundColor: tone.background, borderColor: tone.border }]}
      >
        <View style={styles.glyphColumn}>
          {/*
            The waveform. Four bars of fixed height so the shape is the same with motion off - the
            animation changes only their opacity, and the shape is what says "this is the talk
            control" when nothing is moving.
          */}
          <Animated.View
            style={[
              styles.wave,
              {
                opacity: presentation.live
                  ? pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] })
                  : 0.5,
              },
            ]}
          >
            {[8, 14, 11, 6].map((height, index) => (
              <View
                key={`${String(index)}-${String(height)}`}
                style={[styles.waveBar, { height, backgroundColor: tone.foreground }]}
              />
            ))}
          </Animated.View>
        </View>

        <View style={styles.labelColumn}>
          <Typography role="label" style={{ color: tone.foreground }} decorative>
            {presentation.label}
          </Typography>
          <Typography role="caption" style={{ color: tone.foreground }} decorative>
            {presentation.subline}
          </Typography>
        </View>
      </Pressable>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    wrapper: {
      paddingHorizontal: SPACING.lg,
      paddingBottom: SPACING.sm,
      gap: SPACING.sm,
      backgroundColor: theme.canvas.background,
    },
    panel: {
      borderWidth: 1,
      borderRadius: RADIUS.lg,
      padding: SPACING.lg,
      gap: SPACING.sm,
    },
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: SPACING.md,
      minHeight: MIN_TOUCH_TARGET_DP + SPACING.sm,
      paddingHorizontal: SPACING.lg,
      paddingVertical: SPACING.sm,
      borderWidth: 1,
      borderRadius: RADIUS.pill,
    },
    glyphColumn: { width: 28, alignItems: 'center' },
    wave: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    waveBar: { width: 3, borderRadius: 2 },
    // Grows with the label rather than clipping it: at the 2x scale this app supports, "Needs your
    // confirmation" is two lines and both of them have to be there.
    labelColumn: { flex: 1, gap: SPACING.xxs },
  });
