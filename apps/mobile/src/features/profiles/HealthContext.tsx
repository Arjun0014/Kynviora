/**
 * What a household records about a person, and what Kynviora can do with it.
 *
 * Spec references: `04` Phase 1.3 (allergy/sensitivity records; provenance; last reviewed date -
 * with the exit criterion "no OCR or inferred fact silently becomes a confirmed diagnosis"), `16`
 * (data minimisation), `18` (48dp targets, a label always present, meaning never carried by colour
 * alone), `10` (state the limits where you state the findings), `09`, `02`, `13`.
 *
 * THIS SCREEN COMPOSES NOTHING
 * Every label, every reason a field is asked for, and both sentences about what Kynviora can check
 * come from `@kynviora/presentation` by way of `healthContextView`. `apps/**` is outside the test
 * run (`BLK-002`), so copy written here would be the one family of user-visible strings nothing
 * ever scans.
 *
 * THE LIMIT IS ON EVERY ROW, NOT IN A FOOTNOTE
 * Nothing in this build maps a typed term to a substance the catalog knows, so most records cannot
 * drive a safety check at all. A person who typed "penicillin" has every reason to assume otherwise
 * and would find out through an alert that never arrives. Each row says which it is.
 *
 * NOTHING HERE ASKS WHERE THE FACT CAME FROM
 * There is no provenance control and there is not one to add. The server derives it from who is
 * writing, which is the whole of Phase 1.3's first exit criterion - a field on this screen would
 * be the way round it.
 *
 * THE REVIEW DATE IS A FACT, NOT A NAG
 * "Nobody has checked this" is information. There is no count of unreviewed records, no badge and
 * no ordering by staleness: `02` names that as the anti-feature, and this is somebody's own
 * account of their own body.
 */

import { useCallback, useState } from 'react';
import { View, Text, TextInput, StyleSheet, Pressable } from 'react-native';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  MIN_TOUCH_TARGET_DP,
  HEALTH_CONTEXT_COPY,
  certaintyOptions,
  healthFactKindOptions,
  type ScreenState as ScreenStateKind,
} from '@kynviora/presentation';
import {
  messageForFailure,
  screenStateForFailure,
  type HealthContextView,
  type HealthFactBody,
  type HealthFactRowView,
} from '@kynviora/contracts';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import { useApi } from '@/api/ApiProvider';

export interface HealthContextProps {
  readonly view: HealthContextView;
  readonly profileId: string;
  /** Called once the server has written something, so the list re-reads rather than guessing. */
  readonly onChanged: () => void;
}

export function HealthContext({ view, profileId, onChanged }: HealthContextProps) {
  const { client } = useApi();

  const [kind, setKind] = useState('');
  const [term, setTerm] = useState('');
  const [certainty, setCertainty] = useState('');
  const [notedOn, setNotedOn] = useState('');

  const [state, setState] = useState<ScreenStateKind | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [refusedField, setRefusedField] = useState<string | null>(null);

  const onAdd = useCallback(() => {
    if (client === null) return;

    setState('LOADING');
    setMessage(null);
    setRefusedField(null);

    // No `provenance` and no `substanceId`. There is no field for either, which is the point.
    const body: HealthFactBody = {
      kind,
      displayTerm: term,
      certainty: certainty === '' ? null : certainty,
      notedOn: notedOn.trim() === '' ? null : notedOn.trim(),
    };

    void client.addHealthFact(profileId, body).then(
      (outcome) => {
        if (outcome.kind === 'OK') {
          setState(null);
          setKind('');
          setTerm('');
          setCertainty('');
          setNotedOn('');
          onChanged();
          return;
        }
        setState(screenStateForFailure(outcome));
        setMessage(messageForFailure(outcome));
        // Read as a value rather than parsed out of the message (`13`).
        const field = outcome.kind === 'REFUSED' ? outcome.detail?.['field'] : undefined;
        setRefusedField(typeof field === 'string' ? field : null);
      },
      () => {
        setState('RECOVERABLE_ERROR');
        setMessage(null);
      },
    );
  }, [client, profileId, kind, term, certainty, notedOn, onChanged]);

  const onReview = useCallback(
    (row: HealthFactRowView) => {
      if (client === null) return;

      setState('LOADING');
      setMessage(null);

      void client
        .updateHealthFact(row.id, { expectedVersion: row.version, markReviewed: true })
        .then(
          (outcome) => {
            if (outcome.kind === 'OK') {
              setState(null);
              onChanged();
              return;
            }
            // A conflict here means somebody else changed the record while this list was open.
            // The copy says nothing was saved, which is true: the write was conditional.
            setState(screenStateForFailure(outcome));
            setMessage(
              outcome.kind === 'REFUSED' &&
                outcome.detail?.['reason_code'] === 'health_fact_version'
                ? HEALTH_CONTEXT_COPY.conflictNote
                : messageForFailure(outcome),
            );
          },
          () => {
            setState('RECOVERABLE_ERROR');
            setMessage(null);
          },
        );
    },
    [client, onChanged],
  );

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        {HEALTH_CONTEXT_COPY.heading}
      </Text>
      {/* What Kynviora keeps and why, before anything is asked for (`16`). */}
      <Text style={styles.body}>{HEALTH_CONTEXT_COPY.intro}</Text>

      {state !== null ? <ScreenState state={state} message={message} /> : null}

      {view.isEmpty ? (
        <Text style={styles.help}>{HEALTH_CONTEXT_COPY.emptyNote}</Text>
      ) : (
        view.rows.map((row) => (
          <View key={row.id} style={styles.row}>
            {/* What the person wrote, first and unaltered. */}
            <Text style={styles.rowTerm}>{row.displayTerm}</Text>

            <Text style={styles.help}>
              {[row.kindLabel, row.certaintyLabel, row.provenanceLabel]
                .filter((part): part is string => part !== null)
                .join(' · ')}
            </Text>

            {row.notedOn === null ? null : (
              <Text style={styles.help}>
                {HEALTH_CONTEXT_COPY.notedOnLabel} {row.notedOn}
              </Text>
            )}

            {/* On every row. See the module note. */}
            <Text style={row.matchesCanonicalSubstance ? styles.help : styles.limitation}>
              {row.matchNote}
            </Text>

            {row.reviewNote === null ? null : <Text style={styles.help}>{row.reviewNote}</Text>}

            <PrimaryButton
              label={HEALTH_CONTEXT_COPY.reviewLabel}
              variant="secondary"
              disabled={state === 'LOADING'}
              onPress={() => {
                onReview(row);
              }}
            />
          </View>
        ))
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Adding one.                                                         */}
      {/* ------------------------------------------------------------------ */}

      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={HEALTH_CONTEXT_COPY.kindLabel}
        style={styles.field}
      >
        <Text style={styles.label}>{HEALTH_CONTEXT_COPY.kindLabel}</Text>
        {healthFactKindOptions().map((option) => (
          <Choice
            key={option.kind}
            label={option.label}
            help={option.description}
            selected={kind === option.kind}
            refused={refusedField === 'kind'}
            onPress={() => {
              setKind(option.kind);
            }}
          />
        ))}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>{HEALTH_CONTEXT_COPY.termLabel}</Text>
        <Text style={styles.help}>{HEALTH_CONTEXT_COPY.termHelp}</Text>
        <TextInput
          accessibilityLabel={`${HEALTH_CONTEXT_COPY.termLabel}. ${HEALTH_CONTEXT_COPY.termHelp}`}
          value={term}
          onChangeText={setTerm}
          autoCorrect={false}
          style={[styles.input, refusedField === 'displayTerm' ? styles.inputRefused : null]}
        />
      </View>

      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={HEALTH_CONTEXT_COPY.certaintyLabel}
        style={styles.field}
      >
        <Text style={styles.label}>{HEALTH_CONTEXT_COPY.certaintyLabel}</Text>
        {/* Said whichever they pick: Kynviora records this as their own account either way. */}
        <Text style={styles.help}>{HEALTH_CONTEXT_COPY.certaintyHelp}</Text>
        {certaintyOptions().map((option) => (
          <Choice
            key={option.certainty}
            label={option.label}
            help={option.description}
            selected={certainty === option.certainty}
            refused={refusedField === 'certainty'}
            onPress={() => {
              setCertainty(option.certainty);
            }}
          />
        ))}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>{HEALTH_CONTEXT_COPY.notedOnLabel}</Text>
        <Text style={styles.help}>{HEALTH_CONTEXT_COPY.notedOnHelp}</Text>
        <TextInput
          accessibilityLabel={`${HEALTH_CONTEXT_COPY.notedOnLabel}. ${HEALTH_CONTEXT_COPY.notedOnHelp}`}
          value={notedOn}
          onChangeText={setNotedOn}
          autoCorrect={false}
          autoCapitalize="none"
          placeholder="2024-06-01"
          style={[styles.input, refusedField === 'notedOn' ? styles.inputRefused : null]}
        />
      </View>

      <PrimaryButton
        label={HEALTH_CONTEXT_COPY.saveLabel}
        disabled={state === 'LOADING'}
        onPress={onAdd}
      />
    </View>
  );
}

/** One labelled choice. `accessibilityState.checked` rather than colour alone (`18`). */
function Choice({
  label,
  help,
  selected,
  refused,
  onPress,
}: {
  readonly label: string;
  readonly help: string;
  readonly selected: boolean;
  readonly refused: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={`${label}. ${help}`}
      onPress={onPress}
      style={[
        styles.choice,
        selected ? styles.choiceSelected : null,
        refused && !selected ? styles.choiceRefused : null,
      ]}
    >
      <Text style={styles.choiceLabel}>
        {selected ? '✓ ' : ''}
        {label}
      </Text>
      <Text style={styles.help}>{help}</Text>
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
  // The sentence a person has to read before relying on a record. Given its own weight, and
  // `informational` rather than `attention`: an unmatched term is not a warning about a medicine.
  limitation: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.informational.foreground,
    backgroundColor: LIGHT_THEME.informational.background,
    borderColor: LIGHT_THEME.informational.border,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    padding: SPACING.sm,
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
  inputRefused: {
    borderColor: LIGHT_THEME.attention.border,
    backgroundColor: LIGHT_THEME.attention.background,
  },
  row: {
    gap: SPACING.xs,
    padding: SPACING.md,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
    backgroundColor: LIGHT_THEME.surface.background,
  },
  rowTerm: {
    fontSize: FONT_SIZE.body,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
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
  choiceRefused: {
    borderColor: LIGHT_THEME.attention.border,
  },
  choiceLabel: {
    fontSize: FONT_SIZE.body,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
});
