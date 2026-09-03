/**
 * The first screen anybody sees: making a household, then the first person in it.
 *
 * Spec references: `04` Phase 1.2 (household record; personal and family-member profiles; display
 * identity, age range, language; "clear distinction between account holder and managed profile"),
 * `16` (data minimisation), `18` (48dp targets, a label always present, meaning never carried by
 * colour alone), `10` (state the limits where you state the findings), `13`, `09`.
 *
 * THIS SCREEN COMPOSES NOTHING
 * Every label, every reason a field is being asked for, and the sentence about what Kynviora does
 * not hold come from `@kynviora/presentation`. `apps/**` is outside the test run (`BLK-002`), so
 * copy written here would be the one family of user-visible strings nothing ever scans.
 *
 * TWO STEPS, BECAUSE THEY ARE TWO WRITES - AND USUALLY ONLY THE SECOND
 * The household and the profile are separate rows with separate idempotency keys, and the second
 * needs the first one's ID. Showing them as one form would mean either holding a half-finished
 * household while somebody fills in a name, or writing both on one press and having no honest
 * answer when the second fails. The step is visible because the failure is.
 *
 * The household step is skipped where the caller already has one: adding a second person adds them
 * beside the first, never to a new household. A family split across two households would collect
 * separate items, caregivers and safety history, and nothing in this build merges them.
 *
 * ONE KEY PER STEP, NOT PER PRESS
 * `13` requires the server to commit exactly once, and the server requires the key. Each key is
 * generated when its step opens and kept for every attempt at that step, so a person on a bad
 * connection tapping twice gets one household and one person - and a submission the server refused
 * leaves the key unused, so correcting a field and trying again is the same create rather than a
 * second one. Two households are not a duplicate row: every later record hangs off one, and
 * nothing in this build merges them.
 *
 * NOTHING TYPED HERE IS REPAIRED
 * The values go up as typed. `58` is not read as `1958`; the domain refuses it and names the
 * field, and this screen points at that field.
 */

import { useCallback, useMemo, useState } from 'react';
import { View, Text, TextInput, StyleSheet, Pressable } from 'react-native';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  MIN_TOUCH_TARGET_DP,
  HOUSEHOLD_COPY,
  PROFILE_COPY,
  PROFILE_LIMITS_COPY,
  ageBandOptions,
  type ScreenState as ScreenStateKind,
} from '@kynviora/presentation';
import { bandMatchesBirthYear, isAgeBand, type AgeBand } from '@kynviora/domain';
import {
  emptyProfileForm,
  messageForFailure,
  profileBodyFrom,
  profileFormRefusal,
  screenStateForFailure,
  type ProfileFormValues,
} from '@kynviora/contracts';
import { useApi } from '@/api/ApiProvider';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import { newIdempotencyKey } from '@/platform/ids';

export interface SetUpHouseholdProps {
  /**
   * The household to add the person to, or `null` to make one first.
   *
   * From `profileSwitcherView`, which reads it off a profile the server already admitted. A
   * household ID the caller does not own is refused by `profile_insert` rather than by anything
   * here, so this being wrong is a screen bug and never an authorization one.
   */
  readonly householdId: string | null;
  /**
   * Called once a profile exists, so the app re-reads the server's list rather than selecting a
   * profile it invented. `13`: the selectable set is the authorised set by construction.
   */
  readonly onCreated: () => void;
  /** Absent where there is nothing to go back to - the very first run has no other screen. */
  readonly onClose?: (() => void) | undefined;
}

export function SetUpHousehold({
  householdId: existingHousehold,
  onCreated,
  onClose,
}: SetUpHouseholdProps) {
  const { client } = useApi();

  const [householdId, setHouseholdId] = useState<string | null>(existingHousehold);
  const [householdName, setHouseholdName] = useState('');
  const [values, setValues] = useState<ProfileFormValues>(() => emptyProfileForm());

  const [state, setState] = useState<ScreenStateKind | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** The field a refusal was about, so the form points at it rather than guessing. */
  const [refusedField, setRefusedField] = useState<string | null>(null);
  const [refusalMessage, setRefusalMessage] = useState<string | null>(null);

  // One per step, generated when the screen opens. See the module note.
  const [householdKey] = useState(() => newIdempotencyKey());
  const [profileKey] = useState(() => newIdempotencyKey());

  const clearFeedback = useCallback(() => {
    setState(null);
    setMessage(null);
    setRefusedField(null);
    setRefusalMessage(null);
  }, []);

  const onCreateHousehold = useCallback(() => {
    if (client === null) return;
    clearFeedback();
    setState('LOADING');

    void client.createHousehold({ displayName: householdName }, householdKey).then(
      (outcome) => {
        if (outcome.kind === 'OK') {
          setState(null);
          setHouseholdId(outcome.value.id);
          return;
        }
        setState(screenStateForFailure(outcome));
        setMessage(messageForFailure(outcome));
        // Read as a value rather than parsed out of the message: `13` says clients branch on
        // codes and never on message text.
        const field = outcome.kind === 'REFUSED' ? outcome.detail?.['field'] : undefined;
        setRefusedField(typeof field === 'string' ? field : null);
      },
      () => {
        setState('RECOVERABLE_ERROR');
        setMessage(null);
      },
    );
  }, [client, householdName, householdKey, clearFeedback]);

  const onCreateProfile = useCallback(() => {
    if (client === null || householdId === null) return;

    clearFeedback();

    // Refused here rather than at the server where the domain can already answer, so the message
    // arrives beside the field instead of after a round trip. The rules are the domain's; nothing
    // on this screen re-implements them.
    const refusal = profileFormRefusal(values);
    if (refusal !== null) {
      setRefusedField(refusal.field);
      setRefusalMessage(refusal.message);
      return;
    }

    setState('LOADING');

    void client.createProfile(profileBodyFrom(householdId, values), profileKey).then(
      (outcome) => {
        if (outcome.kind === 'OK') {
          setState(null);
          onCreated();
          return;
        }
        setState(screenStateForFailure(outcome));
        setMessage(messageForFailure(outcome));
        const field = outcome.kind === 'REFUSED' ? outcome.detail?.['field'] : undefined;
        setRefusedField(typeof field === 'string' ? field : null);
      },
      () => {
        setState('RECOVERABLE_ERROR');
        setMessage(null);
      },
    );
  }, [client, householdId, values, profileKey, onCreated, clearFeedback]);

  /**
   * Whether the band and the year look like the same person.
   *
   * A question rather than a refusal, and the year is passed rather than read inside the domain
   * (DEC-024). Somebody who taps the wrong band has made a correctable mistake; refusing the form
   * would throw away everything else they typed.
   */
  const mismatch = useMemo(() => {
    const band = isAgeBand(values.ageBand) ? (values.ageBand as AgeBand) : null;
    const year = /^\d{4}$/.test(values.birthYear.trim()) ? Number(values.birthYear.trim()) : null;
    return !bandMatchesBirthYear(band, year, new Date().getFullYear());
  }, [values.ageBand, values.birthYear]);

  // -------------------------------------------------------------------------
  // Step one: the household
  // -------------------------------------------------------------------------

  if (householdId === null) {
    return (
      <View style={styles.container}>
        <Text accessibilityRole="header" style={styles.heading}>
          {HOUSEHOLD_COPY.heading}
        </Text>
        <Text style={styles.body}>{HOUSEHOLD_COPY.intro}</Text>

        {state !== null ? <ScreenState state={state} message={message} /> : null}

        <View style={styles.field}>
          <Text style={styles.label}>{HOUSEHOLD_COPY.nameLabel}</Text>
          <Text style={styles.help}>{HOUSEHOLD_COPY.nameHelp}</Text>
          <TextInput
            accessibilityLabel={`${HOUSEHOLD_COPY.nameLabel}. ${HOUSEHOLD_COPY.nameHelp}`}
            value={householdName}
            onChangeText={setHouseholdName}
            autoCorrect={false}
            style={[styles.input, refusedField === 'displayName' ? styles.inputRefused : null]}
          />
        </View>

        {/* Said before the first thing Kynviora ever asks for, not after. */}
        <Text style={styles.help}>{HOUSEHOLD_COPY.privacyNote}</Text>

        <PrimaryButton
          label={HOUSEHOLD_COPY.saveLabel}
          disabled={state === 'LOADING'}
          onPress={onCreateHousehold}
        />
        {onClose === undefined ? null : (
          <PrimaryButton label="Cancel" variant="secondary" onPress={onClose} />
        )}
      </View>
    );
  }

  // -------------------------------------------------------------------------
  // Step two: the first person in it
  // -------------------------------------------------------------------------

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        {PROFILE_COPY.heading}
      </Text>
      <Text style={styles.body}>{PROFILE_COPY.intro}</Text>

      {state !== null ? <ScreenState state={state} message={message} /> : null}

      <View style={styles.field}>
        <Text style={styles.label}>{PROFILE_COPY.nameLabel}</Text>
        <Text style={styles.help}>{PROFILE_COPY.nameHelp}</Text>
        <TextInput
          accessibilityLabel={`${PROFILE_COPY.nameLabel}. ${PROFILE_COPY.nameHelp}`}
          value={values.displayName}
          onChangeText={(next) => {
            setValues((current) => ({ ...current, displayName: next }));
          }}
          autoCorrect={false}
          style={[styles.input, refusedField === 'displayName' ? styles.inputRefused : null]}
        />
      </View>

      {/* The account-holder distinction, as two labelled choices rather than a switch. A switch
          labelled "managed" would leave a person guessing which way is which, on the one answer
          that decides whether the profile is theirs. */}
      <View
        accessibilityRole="radiogroup"
        // The group's own label, so a screen reader announces what the two options are about.
        accessibilityLabel={PROFILE_COPY.heading}
        style={styles.field}
      >
        <Choice
          label={PROFILE_COPY.selfLabel}
          help={PROFILE_COPY.selfHelp}
          selected={values.isSelf}
          onPress={() => {
            setValues((current) => ({ ...current, isSelf: true }));
          }}
        />
        <Choice
          label={PROFILE_COPY.otherLabel}
          help={PROFILE_COPY.otherHelp}
          selected={!values.isSelf}
          onPress={() => {
            setValues((current) => ({ ...current, isSelf: false }));
          }}
        />
      </View>

      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={PROFILE_COPY.ageLabel}
        style={styles.field}
      >
        <Text style={styles.label}>{PROFILE_COPY.ageLabel}</Text>
        <Text style={styles.help}>{PROFILE_COPY.ageHelp}</Text>

        {ageBandOptions().map((option) => (
          <Choice
            key={option.band}
            label={option.label}
            help={option.description}
            selected={values.ageBand === option.band}
            onPress={() => {
              setValues((current) => ({
                // Tapping the chosen band again clears it. "Rather not say" is a real answer and
                // has to stay reachable after somebody has picked something.
                ...current,
                ageBand: current.ageBand === option.band ? '' : option.band,
              }));
            }}
          />
        ))}

        <Choice
          label={PROFILE_COPY.ageSkipLabel}
          help={null}
          selected={values.ageBand === ''}
          onPress={() => {
            setValues((current) => ({ ...current, ageBand: '' }));
          }}
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>{PROFILE_COPY.yearLabel}</Text>
        <Text style={styles.help}>{PROFILE_COPY.yearHelp}</Text>
        <TextInput
          accessibilityLabel={`${PROFILE_COPY.yearLabel}. ${PROFILE_COPY.yearHelp}`}
          value={values.birthYear}
          onChangeText={(next) => {
            setValues((current) => ({ ...current, birthYear: next }));
          }}
          autoCorrect={false}
          autoCapitalize="none"
          placeholder="1958"
          style={[styles.input, refusedField === 'birthYear' ? styles.inputRefused : null]}
        />
      </View>

      {/* A note, not a refusal. Both values are saved as entered. */}
      {mismatch ? <Text style={styles.note}>{PROFILE_COPY.ageMismatchNote}</Text> : null}

      <View style={styles.field}>
        <Text style={styles.label}>{PROFILE_COPY.languageLabel}</Text>
        <Text style={styles.help}>{PROFILE_COPY.languageHelp}</Text>
        <TextInput
          accessibilityLabel={`${PROFILE_COPY.languageLabel}. ${PROFILE_COPY.languageHelp}`}
          value={values.languageTag}
          onChangeText={(next) => {
            setValues((current) => ({ ...current, languageTag: next }));
          }}
          autoCorrect={false}
          autoCapitalize="none"
          placeholder="en-IN"
          style={[styles.input, refusedField === 'languageTag' ? styles.inputRefused : null]}
        />
      </View>

      {refusalMessage === null ? null : <Text style={styles.refusal}>{refusalMessage}</Text>}

      <Text style={styles.help}>{PROFILE_COPY.privacyNote}</Text>
      {/* `10`. A form that asked for everything else and silently omitted an emergency contact
          would leave somebody assuming Kynviora holds one. */}
      <Text style={styles.help}>{PROFILE_LIMITS_COPY.noEmergencyContact}</Text>

      <PrimaryButton
        label={PROFILE_COPY.saveLabel}
        disabled={state === 'LOADING'}
        onPress={onCreateProfile}
      />
    </View>
  );
}

/**
 * One labelled choice.
 *
 * `accessibilityState.checked` rather than colour alone (`18`), and the whole row is the target so
 * it clears 48dp without depending on the label's length.
 */
function Choice({
  label,
  help,
  selected,
  onPress,
}: {
  readonly label: string;
  readonly help: string | null;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={help === null ? label : `${label}. ${help}`}
      onPress={onPress}
      style={[styles.choice, selected ? styles.choiceSelected : null]}
    >
      {/* A mark as well as the border, because meaning is never carried by colour alone. */}
      <Text style={styles.choiceLabel}>
        {selected ? '✓ ' : ''}
        {label}
      </Text>
      {help === null ? null : <Text style={styles.help}>{help}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { gap: SPACING.md },
  heading: {
    fontSize: FONT_SIZE.title,
    fontWeight: '700',
    color: LIGHT_THEME.surface.foreground,
  },
  body: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surface.foreground,
  },
  help: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
  label: {
    fontSize: FONT_SIZE.body,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  field: { gap: SPACING.xs },
  input: {
    minHeight: MIN_TOUCH_TARGET_DP,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
    backgroundColor: LIGHT_THEME.surfaceMuted.background,
    fontSize: FONT_SIZE.body,
    color: LIGHT_THEME.surface.foreground,
  },
  // `attention`, not `action`. A mistyped year is something to fix, not a recall.
  inputRefused: {
    borderColor: LIGHT_THEME.attention.border,
    backgroundColor: LIGHT_THEME.attention.background,
  },
  choice: {
    minHeight: MIN_TOUCH_TARGET_DP,
    gap: 2,
    padding: SPACING.md,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
    backgroundColor: LIGHT_THEME.surface.background,
  },
  choiceSelected: {
    borderColor: LIGHT_THEME.informational.border,
    backgroundColor: LIGHT_THEME.informational.background,
  },
  choiceLabel: {
    fontSize: FONT_SIZE.body,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  note: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.informational.foreground,
    backgroundColor: LIGHT_THEME.informational.background,
    borderColor: LIGHT_THEME.informational.border,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    padding: SPACING.md,
  },
  refusal: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.attention.foreground,
  },
});
