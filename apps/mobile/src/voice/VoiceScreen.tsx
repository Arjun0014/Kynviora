/**
 * Voice Mode, as a screen.
 *
 * Spec references: `18` (48dp minimum and much more here; one primary action; no swipe-only or
 * long-press-only control; meaning never carried by colour alone; system font scaling), `06`
 * (Voice Mode is an action available from every destination, not a sixth one), `12`, `17`.
 * DEC-134, DEC-136, `BLK-012`.
 *
 * THE FOUR THINGS THIS SCREEN HAS TO DO
 *
 *  1. **Say what state it is in, unmistakably.** Listening, thinking, speaking and waiting-for-you
 *     are four different things, and a person who cannot tell them apart talks over the app. The
 *     state is a line of text as well as a colour, because `18` forbids colour alone - and because
 *     the person most likely to be here is the person least likely to read a subtle cue.
 *  2. **Show the transcript.** Voice with no transcript is unusable for anybody hard of hearing,
 *     and it is the record of what was said when the app read something out and the person missed
 *     it. It is also the accessible half: a screen reader reads a transcript perfectly well.
 *  3. **Make the confirmation impossible to get wrong.** The summary is large, in full, above two
 *     buttons that are far apart and say what they do - not "OK" and "Cancel", which are the same
 *     word to somebody who did not hear the question.
 *  4. **Hand back to touch without losing anything.** Every tool opens its own screen; leaving
 *     Voice Mode leaves the app exactly where the conversation got to.
 *
 * WHAT IT LOOKS LIKE WITH NO PROVIDER
 * There is no recogniser and no voice in this build (`BLK-012`). The screen says so, plainly, and
 * offers the same conversation by typing - which exercises the identical path and is a usable
 * interface in its own right. It does not pretend to listen.
 */

import { useState } from 'react';
import { View, TextInput, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  MIN_TOUCH_TARGET_DP,
  RADIUS,
  SPACING,
  typeStyle,
  type Theme,
} from '@kynviora/presentation';
import { Card } from '@/components/Card';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Typography } from '@/components/Typography';
import { useThemedStyles, useTheme } from '@/theme/ThemeProvider';
import { useVoice } from './VoiceProvider';

/**
 * What each state is called, and what shape stands for it.
 *
 * A word and a glyph, never a colour on its own. The glyphs are distinguishable by shape for the
 * same reason the status chips' are: this has to be readable in greyscale.
 */
const STATE_COPY = Object.freeze({
  IDLE: { label: 'Ready', glyph: '○', hint: 'Ask Kynviora something, or press Done.' },
  LISTENING: { label: 'Listening', glyph: '●', hint: 'Say what you would like.' },
  THINKING: { label: 'Working it out', glyph: '…', hint: 'One moment.' },
  SPEAKING: { label: 'Answering', glyph: '▶', hint: 'Kynviora is answering.' },
  AWAITING_CONFIRMATION: {
    label: 'Waiting for you',
    glyph: '?',
    // Deliberately not "nothing has happened yet" - the card below says exactly that, and the
    // same sentence twice on one screen is one a person reads once and then stops reading.
    hint: 'Choose one of the two answers below.',
  },
  WORKING: { label: 'Doing it', glyph: '⚙', hint: 'One moment.' },
});

/**
 * The minimum height of a confirmation control.
 *
 * Well beyond the 48dp floor. `18` asks for one obvious action on a high-impact screen; this is
 * the highest-impact control in the app, it is being used by somebody who may not be looking at
 * it, and the cost of a mis-tap is a record about their medicine.
 */
const CONFIRM_TARGET_DP = 88;

/**
 * What the confirmation card says before it says what is about to happen.
 *
 * A constant because it is also the thing `verify:device:voice` looks for: a marker a harness has
 * to spell out by hand is one that goes stale the first time the copy is edited.
 */
export const ARMED_MARKER = 'Nothing has happened yet';

export function VoiceScreen({ onClose }: { readonly onClose: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const { session, say, confirm, cancel, close, canListen, canSpeak } = useVoice();
  const [typed, setTyped] = useState('');

  const state = STATE_COPY[session.state];
  const pending = session.pending;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      {/* `flex: 1` on the ScrollView itself, not only on the frame around it.
          Voice Mode is drawn **instead of** the navigator (`VoiceHost`), so unlike every other
          screen in this app it is not inside a container the navigator has already given a
          height. Without this the ScrollView sizes itself to its content, which grows with the
          transcript - and by the third exchange the field and both buttons were below the fold
          with nothing able to bring them into view. That is `DEV-046` on a new screen, found by
          `verify:device:voice` on its first run (`DEV-075`). */}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <Typography role="heading" heading>
          Talk to Kynviora
        </Typography>

        {/* State, said in a word and drawn in a shape. Announced politely so it does not interrupt
            what a screen reader is already reading (`18`). */}
        <View
          accessible
          accessibilityLiveRegion="polite"
          accessibilityLabel={`${state.label}. ${state.hint}`}
          style={[
            styles.state,
            session.state === 'LISTENING' || session.state === 'AWAITING_CONFIRMATION'
              ? {
                  borderColor: theme.selection.border,
                  backgroundColor: theme.selection.background,
                }
              : null,
          ]}
        >
          <Typography role="display" decorative align="center">
            {state.glyph}
          </Typography>
          <Typography role="title" decorative align="center">
            {state.label}
          </Typography>
          <Typography role="body" colour="secondary" decorative align="center">
            {state.hint}
          </Typography>
        </View>

        {/* The confirmation, and nothing else on screen competing with it. The summary is in full
            and at `bodyLarge`, because a person agreeing to something has to be able to read the
            whole of what they are agreeing to without scrolling it out of view. */}
        {pending === null ? null : (
          <Card
            tone="attention"
            level="raised"
            // One announcement rather than two. A screen reader landing on the warning and then
            // on the summary hears two fragments and may act on the first; landing on both
            // together hears the thing it is about to be asked to agree to.
            accessibilityLabel={`${ARMED_MARKER}. ${pending.summary}`}
          >
            <Typography role="overline" colour="attention" decorative>
              {ARMED_MARKER}
            </Typography>
            <Typography role="bodyLarge" colour="attention" decorative>
              {pending.summary}
            </Typography>
            <View style={styles.confirmActions}>
              {/* Named for what they do rather than "OK" and "Cancel", which are the same word to
                  somebody who did not hear the question. */}
              <PrimaryButton
                label="Yes, do that"
                accessibilityHint={pending.summary}
                style={styles.confirmButton}
                onPress={() => {
                  confirm(pending.id);
                }}
              />
              <PrimaryButton
                label="No, leave it"
                variant="secondary"
                style={styles.confirmButton}
                onPress={cancel}
              />
            </View>
          </Card>
        )}

        {/* What was said, both sides, oldest first. The accessible half of a voice interface, and
            the only half that exists in this build. */}
        <Typography role="overline" colour="secondary" heading>
          What was said
        </Typography>
        <Card>
          {session.transcript.length === 0 ? (
            <Typography role="body" colour="secondary">
              Nothing yet.
            </Typography>
          ) : (
            session.transcript.map((entry) => (
              <View
                key={entry.id}
                accessible
                accessibilityLabel={`${entry.speaker === 'PERSON' ? 'You said' : 'Kynviora said'}. ${entry.text}`}
                style={[styles.line, entry.speaker === 'PERSON' ? styles.fromPerson : null]}
              >
                <Typography role="overline" colour="secondary" decorative>
                  {entry.speaker === 'PERSON' ? 'You' : 'Kynviora'}
                </Typography>
                <Typography role="body" decorative>
                  {entry.text}
                </Typography>
              </View>
            ))
          )}
        </Card>

        {/* The honest state of this build. Said on the screen rather than only in a document:
            somebody using it is entitled to know why the microphone does nothing. */}
        {canListen && canSpeak ? null : (
          <Card tone="informational">
            <Typography role="body" colour="informational">
              {canListen
                ? 'Kynviora cannot speak out loud on this phone yet, so its answers are written here.'
                : 'Kynviora cannot listen on this phone yet. You can type instead, and everything else works the same way.'}
            </Typography>
          </Card>
        )}

        {/* Decorative, because the field below carries the same name. Two nodes with one
            accessible name is a screen reader announcing "Type what you would say" twice, and it
            is what stops anything - a person or a harness - saying which of the two it means. */}
        <Typography role="label" decorative>
          Type what you would say
        </Typography>
        <TextInput
          accessibilityLabel="Type what you would say"
          value={typed}
          onChangeText={setTyped}
          multiline
          style={[typeStyle('body', fontScale), styles.input]}
        />
        <PrimaryButton
          label="Ask Kynviora"
          disabled={typed.trim() === ''}
          onPress={() => {
            say(typed.trim());
            setTyped('');
          }}
        />

        <PrimaryButton
          label="Done"
          variant="secondary"
          onPress={() => {
            close();
            onClose();
          }}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: theme.canvas.background },
    scroll: { flex: 1 },
    content: { padding: SPACING.lg, gap: SPACING.lg, paddingBottom: SPACING.xxxl },
    state: {
      gap: SPACING.xs,
      padding: SPACING.xl,
      borderWidth: 1,
      borderRadius: RADIUS.lg,
      borderColor: theme.surface.border,
      backgroundColor: theme.surface.background,
      alignItems: 'center',
    },
    // Far apart, and each one big. The cost of a mis-tap here is a record about somebody's
    // medicine, so the two are stacked rather than side by side - a thumb reaching for one must
    // not be able to graze the other.
    confirmActions: { gap: SPACING.lg, marginTop: SPACING.md },
    confirmButton: { minHeight: CONFIRM_TARGET_DP, paddingVertical: SPACING.xl },
    line: {
      gap: SPACING.xxs,
      paddingVertical: SPACING.md,
      borderTopWidth: 1,
      borderTopColor: theme.line.hairline,
    },
    // The person's own words sit in a well, so the two sides of a conversation are
    // distinguishable by shape as well as by the label above each (`18`).
    fromPerson: {
      backgroundColor: theme.sunken.background,
      borderRadius: RADIUS.md,
      paddingHorizontal: SPACING.md,
      borderTopWidth: 0,
    },
    input: {
      minHeight: MIN_TOUCH_TARGET_DP * 2,
      borderWidth: 1,
      borderRadius: RADIUS.md,
      borderColor: theme.line.strong,
      backgroundColor: theme.sunken.background,
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.sm,
      color: theme.surface.foreground,
      textAlignVertical: 'top',
    },
  });
