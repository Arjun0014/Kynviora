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
import { View, Text, TextInput, StyleSheet, Pressable } from 'react-native';
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
  medicationLine,
  screenStateForFailure,
  type DifferenceResolution,
  type ReconciliationResponse,
  type ShelfItem,
} from '@kynviora/contracts';
import { useApi } from '@/api/ApiProvider';
import { useProfiles } from '@/api/ProfileProvider';
import { useResource } from '@/api/useResource';
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
  /**
   * The shelf medicine this line is the same as, if the person said so.
   *
   * Null is a real answer - a medicine new to the shelf belongs in exactly that state - and it is
   * also what makes the comparison useful when it is *not* null: the shelf side keys on the
   * item's own ID, so naming it is what turns "present in one list only" into "the strength
   * disagrees".
   */
  readonly matchedItemId: string | null;
}

const emptyLine = (index: number): DraftLine => ({
  key: `line-${String(index)}`,
  displayName: '',
  strengthText: '',
  directionsText: '',
  matchedItemId: null,
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

  /**
   * The medicines already on the shelf, so a line can name one.
   *
   * Loaded here rather than passed in, because the comparison is meaningless without it: with no
   * way to say "this is the same medicine", every line is unmatched by construction and the
   * reconciliation reports only that the two lists differ - which the person already knew.
   */
  const shelfLoad = useMemo(
    () =>
      client === null || activeProfileId === null
        ? null
        : () => client.listItems({ profileId: activeProfileId, itemKind: 'MEDICINE' }),
    [client, activeProfileId],
  );
  const { resource: shelf } = useResource(shelfLoad, { enabled: activeProfileId !== null });
  const shelfItems: readonly ShelfItem[] = shelf.value?.items ?? [];

  const onStart = useCallback(() => {
    if (client === null || activeProfileId === null || filled.length === 0) return;

    setState('LOADING');
    setMessage(null);

    void client
      .startReconciliation({
        profileId: activeProfileId,
        sourceKind: 'OTHER',
        currentList: filled.map((line, index) =>
          medicationLine({
            index,
            displayName: line.displayName,
            strengthText: line.strengthText,
            directionsText: line.directionsText,
            matchedItemId: line.matchedItemId,
          }),
        ),
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

          {/* Which shelf medicine this line is. Optional, and never guessed from the name: two
              packs of the same medicine at different strengths are two real records, and matching
              them by text would be Kynviora deciding which one the person meant. */}
          {shelfItems.length === 0 ? null : (
            <>
              <Text style={styles.label}>Is this one you already have?</Text>
              {[null, ...shelfItems.map((item) => item.id)].map((id) => {
                const chosen = line.matchedItemId === id;
                const label =
                  id === null
                    ? 'No - this one is new to me'
                    : (shelfItems.find((item) => item.id === id)?.displayName ?? '');
                return (
                  <Pressable
                    key={id ?? 'none'}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: chosen }}
                    accessibilityLabel={label}
                    onPress={() => {
                      setLines((current) =>
                        current.map((entry) =>
                          entry.key === line.key ? { ...entry, matchedItemId: id } : entry,
                        ),
                      );
                    }}
                    style={[
                      styles.match,
                      {
                        backgroundColor: chosen
                          ? LIGHT_THEME.informational.background
                          : LIGHT_THEME.surface.background,
                        borderColor: chosen
                          ? LIGHT_THEME.informational.border
                          : LIGHT_THEME.surface.border,
                      },
                    ]}
                  >
                    <Text style={styles.matchLabel}>
                      {chosen ? '●  ' : '○  '}
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </>
          )}
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
  match: {
    minHeight: MIN_TOUCH_TARGET_DP,
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  matchLabel: {
    fontSize: FONT_SIZE.body,
    color: LIGHT_THEME.surface.foreground,
  },
  actions: { gap: SPACING.sm },
});
