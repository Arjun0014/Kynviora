/**
 * Inviting someone to help.
 *
 * Spec references: `04` Phase 8.1, `14` (caregiver administration needs re-authentication; an
 * address is personal data), `16` (a caregiver gets exactly what they were granted), `18` (say
 * what a screen will do before it does it), DEC-018, DEC-020, DEC-116, DEC-130, `DEV-049`,
 * trap 11.
 *
 * THREE STEPS, AND THE ORDER MATTERS
 * Choose, confirm, then the link. Choosing and confirming are separate because `18` requires a
 * screen to state what it is about to do before doing it, and handing out a bearer credential is
 * the most consequential thing this app can do. The link comes last because it does not exist
 * until the request succeeds - the server mints it, stores only a SHA-256 hash, and never emits it
 * again (DEC-018).
 *
 * WHAT HAPPENS TO THE TOKEN HERE
 * It is held in component state, rendered, and dropped when the screen closes. It is never
 * written to storage, never logged, never put in a URL, never included in an error, and never
 * passed to any function other than the `Text` that displays it. `14` and trap 11 are about a live
 * credential, and the way to keep one out of a log is for no code between the response and the
 * screen to touch it.
 *
 * The capabilities offered are only ever the ones this inviter may delegate. A caregiver is not
 * shown a disabled "manage caregivers" box: DEC-020 forbids them delegating it, and a greyed-out
 * control would tell them the capability exists and that they are not trusted with it.
 *
 * THE REVIEW STEP'S ORDER IS MEASURED ON A DEVICE, AND IS NOT A LAYOUT CHOICE
 * `verify:device:doseaccess` `DOSE-2` reads every line of the review screen in draw order and
 * asserts that "They can record that a medicine was taken..." falls **under** the "able to change"
 * heading and not under "able to see". Both headings are on the same screen, so a check for the
 * words alone would be answered by the wrong one - which is why it measures position.
 *
 * That is `DEV-049` in one sentence: the old screen described `VIEW_MEDICINES` as letting somebody
 * "see", over a grant that carried a write into the dose history a person hands a doctor. Splitting
 * the capability fixed the policy; filing the new one under "see" would have reproduced the defect
 * under a new name. So seeing comes first and changing second, `summarizeAccess` decides which line
 * goes where, and **neither block is wrapped in an `accessible` container** - a container with its
 * own label collapses its children on Android, and the sentence the check looks for would stop
 * being on screen as far as anything reading the hierarchy is concerned.
 *
 * WHAT IS NOT SHARED IS A BLOCK, NOT A FOOTNOTE
 * It used to be one lowercased caption of comma-joined labels under two lists of full sentences,
 * which made the granted set scannable and the withheld set a footnote - the same shape the access
 * list was fixed out of. `18` will not let a limitation sit a level below the thing it qualifies,
 * and on this screen the withheld set is what somebody is actually approving the absence of. It is
 * now the third block, in the same well and at the same rank as the other two.
 *
 * WHY A CHOSEN CAPABILITY IS `selection` AND NOT `informational`
 * DEC-130: `selection` is the one hue in this app that is about the interface rather than about a
 * product, and `informational` is the colour a fact about somebody's medicine is drawn in. "This is
 * a box you ticked" and "here is something about your medicine" must not be the same colour, or the
 * second stops being noticeable. The tick is in the label as well, because `18` forbids meaning
 * carried by colour alone.
 */

import { useMemo, useState } from 'react';
import { View, Text, TextInput, StyleSheet, Pressable } from 'react-native';
import {
  SPACING,
  RADIUS,
  MIN_TOUCH_TARGET_DP,
  CAREGIVER_COPY,
  describeCapability,
  invitationExpiryNote,
  summarizeAccess,
  INVITATION_HEADINGS,
  typeStyle,
  type ScreenState as ScreenStateKind,
  type Theme,
} from '@kynviora/presentation';
import type { CaregiverCapability } from '@kynviora/domain';
import {
  buildInvitation,
  selectableCapabilities,
  type InvitationCreated,
  type InviterAuthority,
} from '@kynviora/contracts';
import { Card } from '@/components/Card';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import { Typography } from '@/components/Typography';
import { haptic } from '@/platform/haptics';
import { useThemedStyles } from '@/theme/ThemeProvider';

/** The three headings of a grant, kept together so the two screens describing one cannot drift. */
// From the package, because `accessCoverage` says the same three things about a pending invitation
// on the row afterwards, and two lists of headings drift (`DEV-101`).
const SEEING_HEADING = INVITATION_HEADINGS.seeing;
const CHANGING_HEADING = INVITATION_HEADINGS.changing;
const NOT_INCLUDED_HEADING = INVITATION_HEADINGS.notIncluded;

export interface InviteCaregiverProps {
  readonly profileId: string;
  readonly authority: InviterAuthority;
  readonly invitationTtlDays: number;
  /** Performed with an elevated client. The caller owns the step-up, not this component. */
  readonly onSend: (body: {
    readonly profileId: string;
    readonly capabilities: readonly CaregiverCapability[];
    readonly invitedEmail?: string;
  }) => void;
  readonly onClose: () => void;
  /** Set once the request has succeeded. The only place the token is ever held. */
  readonly created?: InvitationCreated | null;
  readonly state?: ScreenStateKind | null;
  readonly stateMessage?: string | null;
}

export function InviteCaregiver({
  profileId,
  authority,
  invitationTtlDays,
  onSend,
  onClose,
  created,
  state,
  stateMessage,
}: InviteCaregiverProps) {
  const styles = useThemedStyles(makeStyles);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [email, setEmail] = useState('');
  const [confirming, setConfirming] = useState(false);

  const offerable = useMemo(() => selectableCapabilities(authority), [authority]);
  const draft = useMemo(
    () => buildInvitation({ profileId, authority, selected, invitedEmail: email }),
    [profileId, authority, selected, email],
  );

  // The link exists. Nothing else on this screen matters until it has been read.
  if (created != null) return <InvitationLink created={created} onClose={onClose} />;

  if (state != null && state !== 'READY') {
    return <ScreenState state={state} message={stateMessage} />;
  }

  if (confirming) {
    const summary = summarizeAccess(draft.body?.capabilities ?? []);
    return (
      <>
        {/* Exactly what is being shared, in the words the access list uses, so the review and the
            list afterwards cannot describe the same grant differently. Seeing first and changing
            second - see the module note; that order is measured on a device. */}
        <Card>
          <Typography role="title" heading>
            {CAREGIVER_COPY.reviewHeading}
          </Typography>

          <GrantBlock title={SEEING_HEADING} entries={summary.viewing} />
          <GrantBlock title={CHANGING_HEADING} entries={summary.changing} />

          {/* `18` requires the limitation to be stated. Someone reading only what was granted will
              not notice what was withheld, and naming the omissions is what makes a grant legible.
              A block rather than a joined caption, so it is read at the rank the other two are. */}
          <GrantBlock title={NOT_INCLUDED_HEADING} entries={summary.notIncluded} />
        </Card>

        {/* What the person is about to hand over that the three blocks above do not describe: an
            administrator, and a link with no addressee. Both are `attention` - something to look
            at, on the person's own schedule - and both are drawn on that tone's own ground rather
            than as amber text on a plain surface, which would be the one thing `18` forbids. */}
        {summary.administrationWarning === null && draft.body?.invitedEmail !== undefined ? null : (
          <Card tone="attention">
            {summary.administrationWarning === null ? null : (
              <Typography role="body" colour="attention">
                {summary.administrationWarning}
              </Typography>
            )}
            {draft.body?.invitedEmail === undefined ? (
              <Typography role="body" colour="attention">
                {CAREGIVER_COPY.linkWarning}
              </Typography>
            ) : null}
          </Card>
        )}

        <Card>
          <Typography role="body">{invitationExpiryNote(invitationTtlDays)}</Typography>

          {/* `14`: caregiver administration needs re-authentication. The confirmation is the step,
              and the caller performs it - this component never holds an elevated client. */}
          <Typography role="body" colour="secondary">
            {CAREGIVER_COPY.stepUpPrompt}
          </Typography>
        </Card>

        <PrimaryButton
          label="Confirm and create the link"
          accessibilityHint={CAREGIVER_COPY.stepUpPrompt}
          onPress={() => {
            if (draft.body !== null) onSend(draft.body);
          }}
        />
        <PrimaryButton
          label="Back"
          variant="secondary"
          onPress={() => {
            setConfirming(false);
          }}
        />
      </>
    );
  }

  return (
    <>
      <Card>
        <Typography role="title" heading>
          Invite someone
        </Typography>
        <Typography role="body">{CAREGIVER_COPY.inviteIntro}</Typography>
      </Card>

      {/* One idea - what this person may do - so one card. Each row is its own 48dp target that
          grows with the font scale, rather than a fixed height that clips its own second line. */}
      <Card>
        {offerable.map((capability) => {
          const description = describeCapability(capability);
          const chosen = selected.includes(capability);
          return (
            <Pressable
              key={capability}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: chosen }}
              // The bare label. The state belongs in `accessibilityState`, which is where a screen
              // reader looks for it, and a name that changed with the state would be a control
              // that renames itself when pressed - which is also what the device harness finds
              // this row by (`DOSE-1`).
              accessibilityLabel={description.label}
              accessibilityHint={description.meaning}
              onPress={() => {
                haptic('selection');
                setSelected((current) =>
                  chosen ? current.filter((c) => c !== capability) : [...current, capability],
                );
              }}
              style={[styles.capability, chosen ? styles.capabilityChosen : null]}
            >
              {/* The tick duplicates the accessibilityState. `18`: never colour alone. */}
              <Typography
                role="label"
                decorative
                {...(chosen ? { style: styles.chosenLabel } : {})}
              >
                {chosen ? '☑  ' : '☐  '}
                {description.label}
              </Typography>
              <Typography role="caption" colour="secondary" decorative>
                {description.meaning}
              </Typography>
            </Pressable>
          );
        })}
      </Card>

      <Card>
        <Typography role="label">Their email address, if you have it</Typography>
        <Typography role="caption" colour="secondary">
          Adding it means only that address can accept. Leave it blank to send a link anyone holding
          it can use.
        </Typography>
        <TextInput
          accessibilityLabel="Their email address, if you have it"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          style={styles.input}
        />
      </Card>

      {/* Why the form cannot be submitted, whenever it cannot. Never before somebody has done
          anything: a refusal on an untouched form is a screen telling a person off for arriving. */}
      {draft.ok ? null : selected.length === 0 && email.trim() === '' ? null : (
        <Card tone="attention">
          <Typography role="body" colour="attention" announce>
            {draft.refusal?.message}
          </Typography>
        </Card>
      )}

      <PrimaryButton
        label="Review what you are sharing"
        disabled={!draft.ok}
        onPress={() => {
          setConfirming(true);
        }}
      />
      <PrimaryButton label="Cancel" variant="secondary" onPress={onClose} />
    </>
  );
}

/**
 * One labelled part of a grant, or nothing.
 *
 * Absent rather than empty, and that is the interesting case: "what they can change - nothing" is a
 * sentence with two readings, and the wrong one is that changing is something this grant does at a
 * level below what is listed.
 *
 * The heading and its lines are separate nodes on purpose. Wrapping them in one `accessible`
 * container would read better as a single announcement and would take the individual sentences off
 * the hierarchy Android exposes - which is where `DOSE-2` looks for the one about recording a dose.
 */
function GrantBlock({
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

/**
 * The link, shown once.
 *
 * There is no "copy again later" and there cannot be: the server stored a hash and has nothing to
 * re-issue (DEC-018). The sentence saying so is on screen before the value, not after it, because
 * someone who has already navigated away has not read it.
 */
function InvitationLink({
  created,
  onClose,
}: {
  readonly created: InvitationCreated;
  readonly onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <>
      <Card>
        <Typography role="title" heading>
          Send this link
        </Typography>
      </Card>

      {/* Both sentences before the value, on the tone that means "look at this". A live credential
          with no addressee is exactly what `attention` is for, and it is the last moment anybody
          will read either sentence. */}
      <Card tone="attention">
        <Typography role="bodyLarge" colour="attention">
          {CAREGIVER_COPY.linkShownOnce}
        </Typography>
        <Typography role="bodyLarge" colour="attention">
          {CAREGIVER_COPY.linkWarning}
        </Typography>
      </Card>

      <Card>
        {/* Selectable so it can be copied by hand. Not passed to a share sheet, a clipboard helper
            or anything else that could put a live credential somewhere this screen cannot see.
            A raw `Text` rather than `Typography`, because `selectable` is the whole point of it and
            the token is not prose - it is a value in a sunken well, like every other read-only
            block in this app. */}
        <Text selectable style={styles.token} accessibilityLabel="Invitation link">
          {created.token}
        </Text>
      </Card>

      <PrimaryButton label="I have sent it" onPress={onClose} />
    </>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    // The same sunken well the access list and the removal confirmation draw a grant in, so one
    // grant looks like the same object on all three screens.
    block: {
      gap: SPACING.xxs,
      padding: SPACING.md,
      borderRadius: RADIUS.md,
      backgroundColor: theme.sunken.background,
    },
    capability: {
      minHeight: MIN_TOUCH_TARGET_DP,
      justifyContent: 'center',
      gap: SPACING.xxs,
      // `sm`/`md`, not `lg`. `Card` already applies `SPACING.lg` around its contents, so a row
      // adding `lg` of its own is padded twice - and at font scale 2, where each row is already
      // two lines of scaled text, that made the block tall enough that `SHEET-2` could never
      // catch the first and last rows wholly inside the viewport at any scroll position
      // (`DEV-086`). The 48dp floor is `minHeight` and is unaffected by this.
      paddingVertical: SPACING.sm,
      paddingHorizontal: SPACING.md,
      borderWidth: 1,
      borderRadius: RADIUS.md,
      borderColor: theme.line.strong,
      backgroundColor: theme.surface.background,
    },
    capabilityChosen: {
      borderColor: theme.selection.border,
      borderWidth: 2,
      backgroundColor: theme.selection.background,
    },
    // `selection` is a pair rather than one of the seven semantic tones, so `Typography` will not
    // take it by name - a status must not be able to resolve to an interface colour. Named here,
    // beside the background it has to sit on.
    chosenLabel: { color: theme.selection.foreground },
    // A `TextInput` is not `Typography` and cannot be: the text style has to be on the input
    // itself. The size comes from the same role the label uses, resolved at 1x - React Native
    // scales the rendered text on top, as it does everywhere else.
    input: {
      ...typeStyle('body', 1),
      minHeight: MIN_TOUCH_TARGET_DP,
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.sm,
      borderWidth: 1,
      borderRadius: RADIUS.md,
      borderColor: theme.surface.border,
      backgroundColor: theme.sunken.background,
      color: theme.surface.foreground,
    },
    token: {
      ...typeStyle('body', 1),
      color: theme.sunken.foreground,
      backgroundColor: theme.sunken.background,
      borderWidth: 1,
      borderColor: theme.sunken.border,
      borderRadius: RADIUS.md,
      padding: SPACING.md,
    },
  });
