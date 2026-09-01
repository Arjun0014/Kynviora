/**
 * Reconciling a list somebody handed you against the shelf.
 *
 * Spec references: `04` Phase 8.5, `04` Phase 4.1 (a prescription instruction is reproduced
 * verbatim), `09`, `18`, DEC-029, DEC-030, traps 19-21.
 *
 * THREE STEPS: TYPE IT IN, SEE THE DIFFERENCES, SETTLE EACH ONE
 * The list is typed because Kynviora has no other source for it - a discharge summary is a piece
 * of paper. Nothing on this path trims, normalises or sentence-cases what was entered: `04` Phase
 * 4.1 forbids rewriting a prescription instruction, and "tidying" a direction is rewriting it.
 *
 * Settling a difference is two questions, never one. Choosing "a pharmacist confirmed it" does not
 * say which value they confirmed, so the prompt asks - and every settling resolution goes through
 * the same prompt so no path can skip it. That is DEC-030, and it is why this screen has a second
 * step at all.
 *
 * Nothing is applied locally. The server records the resolution and writes the one medicine change
 * through row-level security, so the reconciliation cannot change what the caller could not have
 * changed on the medicine screen itself. The list is re-read afterwards rather than patched.
 */

import { useCallback, useMemo, useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  MIN_TOUCH_TARGET_DP,
  RECONCILIATION_COPY,
  type ScreenState as ScreenStateKind,
} from '@kynviora/presentation';
import type { DifferenceKind, ReconciliationResolution } from '@kynviora/domain';
import {
  asResolution,
  screenStateForFailure,
  type DifferenceResolution,
  type ReconciliationResponse,
} from '@kynviora/contracts';
import { useApi } from '@/api/ApiProvider';
import { useProfiles } from '@/api/ProfileProvider';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import { ReconciliationReview } from './ReconciliationReview';
import { ResolutionPrompt } from './ResolutionPrompt';

/** One typed row of the list the person is holding. */
interface DraftLine {
  readonly key: string;
  readonly displayName: string;
  readonly strengthText: string;
  readonly directionsText: string;
}

const emptyLine = (index: number): DraftLine => ({
  key: `line-${String(index)}`,
  displayName: '',
  strengthText: '',
  directionsText: '',
});

export function ReconciliationFlow({ onClose }: { readonly onClose: () => void }) {
  const { client } = useApi();
  const { activeProfileId } = useProfiles();

  const [lines, setLines] = useState<readonly DraftLine[]>([emptyLine(0)]);
  const [reconciliation, setReconciliation] = useState<ReconciliationResponse | null>(null);
  const [pending, setPending] = useState<{
    readonly differenceId: string;
    readonly resolution: ReconciliationResolution;
    readonly displayName: string;
    readonly previousValue: string | null;
    readonly currentValue: string | null;
  } | null>(null);
  const [state, setState] = useState<ScreenStateKind | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const filled = useMemo(() => lines.filter((line) => line.displayName.trim() !== ''), [lines]);

  const onStart = useCallback(() => {
    if (client === null || activeProfileId === null || filled.length === 0) return;

    setState('LOADING');
    setMessage(null);

    void client
      .startReconciliation({
        profileId: activeProfileId,
        sourceKind: 'OTHER',
        currentList: filled.map((line, index) => ({
          // Positional, because two rows of the same medicine at different strengths are two
          // real lines and must not collapse into one.
          matchKey: `typed:${String(index)}`,
          displayName: line.displayName.trim(),
          strengthText: line.strengthText.trim() === '' ? null : line.strengthText.trim(),
          // Verbatim. Not trimmed of internal spacing, not sentence-cased, not normalised -
          // `04` Phase 4.1 forbids rewriting a prescription instruction.
          directionsText: line.directionsText === '' ? null : line.directionsText,
        })),
      })
      .then(
        (outcome) => {
          if (outcome.kind !== 'OK') {
            setState(screenStateForFailure(outcome));
            setMessage(outcome.kind === 'REFUSED' ? outcome.message : null);
            return;
          }
          // Read back rather than assembled from the create response. The derivation is the
          // server's, and the person must see what it actually produced.
          void client.reconciliation(outcome.value.reconciliationId).then(
            (read) => {
              if (read.kind === 'OK') {
                setState(null);
                setReconciliation(read.value);
                return;
              }
              setState(screenStateForFailure(read));
              setMessage(read.kind === 'REFUSED' ? read.message : null);
            },
            () => {
              setState('RECOVERABLE_ERROR');
              setMessage(null);
            },
          );
        },
        () => {
          setState('RECOVERABLE_ERROR');
          setMessage(null);
        },
      );
  }, [client, activeProfileId, filled]);

  const reload = useCallback(() => {
    if (client === null || reconciliation === null) return;
    void client.reconciliation(reconciliation.reconciliationId).then(
      (outcome) => {
        if (outcome.kind === 'OK') {
          setReconciliation(outcome.value);
          return;
        }
        setState(screenStateForFailure(outcome));
      },
      () => {
        setState('RECOVERABLE_ERROR');
      },
    );
  }, [client, reconciliation]);

  const onRecord = useCallback(
    (body: DifferenceResolution) => {
      if (client === null || reconciliation === null || pending === null) return;

      setState('LOADING');
      setMessage(null);

      void client
        .resolveDifference(reconciliation.reconciliationId, pending.differenceId, body)
        .then(
          (outcome) => {
            setPending(null);
            if (outcome.kind === 'OK') {
              setState(null);
              // Re-read rather than patched. The server writes the medicine change through RLS,
              // so what actually happened is the server's answer and not the client's guess.
              reload();
              return;
            }
            setState(screenStateForFailure(outcome));
            setMessage(outcome.kind === 'REFUSED' ? outcome.message : null);
          },
          () => {
            setPending(null);
            setState('RECOVERABLE_ERROR');
            setMessage(null);
          },
        );
    },
    [client, reconciliation, pending, reload],
  );

  // The prompt that asks which value stands. Every settling resolution goes through it.
  if (pending !== null) {
    return (
      <ResolutionPrompt
        resolution={pending.resolution}
        displayName={pending.displayName}
        previousValue={pending.previousValue}
        currentValue={pending.currentValue}
        onRecord={onRecord}
        onCancel={() => {
          setPending(null);
        }}
      />
    );
  }

  if (reconciliation !== null) {
    return (
      <View style={styles.container}>
        <ReconciliationReview
          state={state ?? 'READY'}
          differences={reconciliation.differences.flatMap((difference) => {
            const resolution =
              difference.resolution === null ? null : asResolution(difference.resolution);
            return [
              {
                differenceId: difference.differenceId,
                kind: difference.kind as DifferenceKind,
                displayName: difference.displayName,
                field: difference.field,
                previousValue: difference.previousValue,
                currentValue: difference.currentValue,
                resolution,
              },
            ];
          })}
          completedUnresolvedCount={
            reconciliation.state === 'COMPLETED' ? reconciliation.unresolvedCount : null
          }
          onChooseResolution={(differenceId, resolution) => {
            const difference = reconciliation.differences.find(
              (entry) => entry.differenceId === differenceId,
            );
            if (difference === undefined) return;
            // Never recorded straight from the list. Choosing a resolution is half the answer;
            // which value stands is the other half, and only a person can give it (DEC-030).
            setPending({
              differenceId,
              resolution,
              displayName: difference.displayName,
              previousValue: difference.previousValue,
              currentValue: difference.currentValue,
            });
          }}
          onRetry={reload}
        />
        <View style={styles.actions}>
          <PrimaryButton label="Done" variant="secondary" onPress={onClose} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        {RECONCILIATION_COPY.heading}
      </Text>
      <Text style={styles.body}>{RECONCILIATION_COPY.intro}</Text>
      <Text style={styles.help}>{RECONCILIATION_COPY.verbatimNote}</Text>

      {state !== null ? <ScreenState state={state} message={message} /> : null}

      {lines.map((line, index) => (
        <View key={line.key} style={styles.line}>
          <Text style={styles.label}>Medicine {index + 1}</Text>
          <TextInput
            accessibilityLabel={`Medicine ${String(index + 1)} name`}
            placeholder="Name"
            value={line.displayName}
            onChangeText={(text) => {
              setLines((current) =>
                current.map((entry) =>
                  entry.key === line.key ? { ...entry, displayName: text } : entry,
                ),
              );
            }}
            style={styles.input}
          />
          <TextInput
            accessibilityLabel={`Medicine ${String(index + 1)} strength`}
            placeholder="Strength, for example 500 mg"
            value={line.strengthText}
            onChangeText={(text) => {
              setLines((current) =>
                current.map((entry) =>
                  entry.key === line.key ? { ...entry, strengthText: text } : entry,
                ),
              );
            }}
            style={styles.input}
          />
          <TextInput
            accessibilityLabel={`Medicine ${String(index + 1)} directions`}
            placeholder="Directions, copied exactly"
            value={line.directionsText}
            onChangeText={(text) => {
              setLines((current) =>
                current.map((entry) =>
                  entry.key === line.key ? { ...entry, directionsText: text } : entry,
                ),
              );
            }}
            multiline
            style={[styles.input, styles.multiline]}
          />
        </View>
      ))}

      <PrimaryButton
        label="Add another medicine"
        variant="secondary"
        onPress={() => {
          setLines((current) => [...current, emptyLine(current.length)]);
        }}
      />
      <PrimaryButton
        label="Compare with my shelf"
        disabled={filled.length === 0}
        onPress={onStart}
      />
      <PrimaryButton label="Cancel" variant="secondary" onPress={onClose} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: SPACING.md,
    padding: SPACING.md,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
    backgroundColor: LIGHT_THEME.surface.background,
  },
  heading: {
    fontSize: FONT_SIZE.title,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  body: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.normal,
    color: LIGHT_THEME.surface.foreground,
  },
  help: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
  label: {
    fontSize: FONT_SIZE.caption,
    fontWeight: '600',
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
  line: {
    gap: SPACING.xs,
    padding: SPACING.sm,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
  },
  input: {
    minHeight: MIN_TOUCH_TARGET_DP,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
    paddingHorizontal: SPACING.md,
    fontSize: FONT_SIZE.body,
    color: LIGHT_THEME.surface.foreground,
  },
  multiline: {
    minHeight: MIN_TOUCH_TARGET_DP * 1.5,
    paddingVertical: SPACING.sm,
    textAlignVertical: 'top',
  },
  actions: { gap: SPACING.sm },
});
