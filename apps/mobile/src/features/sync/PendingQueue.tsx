/**
 * The changes that have not reached the server, and what a person may do about each.
 *
 * Spec references: `12` ("Repository behavior" - a pending-operation journal and a **resolvable**
 * failure state), `13` (per-entity conflict policy; bounded retry), `03` group J, `18`, `06`,
 * `DEV-038`, `DEV-044`.
 *
 * WHAT THIS CLOSES
 * `12` asks for two things in one sentence and the app had one of them. A change made with no
 * signal is kept and sent later - measured on a device by `npm run verify:device:offline`. What was
 * missing is the other half: a person seeing it, and being able to act on one the server refused.
 * `needsUserAttention` has counted those since the journal shipped and nothing has ever shown them,
 * so an edit held safely was indistinguishable from an edit that was saved.
 *
 * It is also what makes `allergy_record` and `condition_record` queueable at all. `13` resolves both
 * `ASK_USER`, and `DEV-038` refused to wire them for a reason that was about this screen rather than
 * about them: offering to keep a change somebody then cannot resolve is worse than saying "not
 * saved" at the time.
 *
 * WHAT IS DECIDED HERE AND WHAT IS NOT
 * Nothing. Which sentence a row gets and which actions it may offer are `pendingQueueView`'s, in
 * `@kynviora/presentation`, where they are tested - `apps/**` is outside the test run and the lint
 * run (trap 164). This file renders that and calls the provider.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import {
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  QUEUE_COPY,
  SPACING,
  pendingQueueView,
  type QueueInput,
  type QueueRow,
  type Theme,
} from '@kynviora/presentation';
import { MAX_UPLOAD_ATTEMPTS, unsafeId, type OperationId } from '@kynviora/domain';
import { PrimaryButton } from '@/components/PrimaryButton';
import { usePendingSync } from '@/sync/PendingSyncProvider';
import { useThemedStyles } from '@/theme/ThemeProvider';

export function PendingQueue() {
  const styles = useThemedStyles(makeStyles);
  const { list, retry, discard, waiting, needsAttention } = usePendingSync();
  const [inputs, setInputs] = useState<readonly QueueInput[]>([]);

  /**
   * Re-read whenever the counts move.
   *
   * The counts are the provider's own summary of the journal, so they change exactly when a pass
   * commits, fails or is resolved - which is precisely when this list is stale. Polling would show
   * the same thing later and for longer.
   */
  const reload = useCallback(() => {
    void list().then(
      (operations) => {
        setInputs(
          operations.map((operation) => ({
            operationId: operation.operationId,
            entityType: operation.entityType,
            mutation: operation.mutation,
            state: operation.state,
            attemptCount: operation.attemptCount,
            maxAttempts: MAX_UPLOAD_ATTEMPTS,
          })),
        );
      },
      () => {
        // A journal that cannot be read is not an empty one, so nothing is replaced. The screen
        // keeps showing what it last knew rather than telling somebody their changes have gone.
      },
    );
  }, [list]);

  useEffect(reload, [reload, waiting, needsAttention]);

  const view = useMemo(() => pendingQueueView(inputs), [inputs]);

  const onRetry = useCallback(
    (operationId: string) => {
      void retry(unsafeId<OperationId>(operationId)).then(reload, reload);
    },
    [retry, reload],
  );

  const onDiscard = useCallback(
    (operationId: string) => {
      void discard(unsafeId<OperationId>(operationId)).then(reload, reload);
    },
    [discard, reload],
  );

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        {QUEUE_COPY.heading}
      </Text>
      {/* Before the list, because the thing a person most needs to know is that nothing was lost. */}
      <Text style={styles.intro}>{QUEUE_COPY.intro}</Text>
      <Text style={styles.summary}>{view.summary}</Text>

      {view.rows.map((row) => (
        <QueueRowView key={row.operationId} row={row} onRetry={onRetry} onDiscard={onDiscard} />
      ))}
    </View>
  );
}

function QueueRowView({
  row,
  onRetry,
  onDiscard,
}: {
  readonly row: QueueRow;
  readonly onRetry: (operationId: string) => void;
  readonly onDiscard: (operationId: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={row.needsDecision ? styles.rowNeedsDecision : styles.row}>
      <Text style={styles.what}>{row.what}</Text>
      <Text style={styles.why}>{row.why}</Text>

      {/* Absent rather than disabled where there is nothing to decide, which is the same rule the
          caregiver controls follow (DEC-045): a control a person cannot use is one they spend
          attention on. */}
      {row.actions.includes('RETRY') ? (
        <PrimaryButton
          label={QUEUE_COPY.retryLabel}
          variant="secondary"
          onPress={() => {
            onRetry(row.operationId);
          }}
        />
      ) : null}
      {row.actions.includes('DISCARD') ? (
        <>
          <PrimaryButton
            label={QUEUE_COPY.discardLabel}
            variant="secondary"
            accessibilityHint={QUEUE_COPY.discardWarning}
            onPress={() => {
              onDiscard(row.operationId);
            }}
          />
          {/* Said next to the control rather than in a dialog. It is the one action here that
              loses something a person wrote, and it cannot be undone. */}
          <Text style={styles.warning}>{QUEUE_COPY.discardWarning}</Text>
        </>
      ) : null}
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { gap: SPACING.md },
    heading: {
      fontSize: FONT_SIZE.heading,
      fontWeight: '700',
      color: theme.surface.foreground,
    },
    intro: {
      fontSize: FONT_SIZE.body,
      lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.surfaceMuted.foreground,
    },
    summary: {
      fontSize: FONT_SIZE.body,
      fontWeight: '700',
      color: theme.surface.foreground,
    },
    row: {
      gap: SPACING.sm,
      padding: SPACING.md,
      borderRadius: SPACING.sm,
      backgroundColor: theme.surfaceMuted.background,
    },
    rowNeedsDecision: {
      gap: SPACING.sm,
      padding: SPACING.md,
      borderRadius: SPACING.sm,
      backgroundColor: theme.surfaceMuted.background,
      borderLeftWidth: SPACING.xs,
      borderLeftColor: theme.surface.foreground,
    },
    what: {
      fontSize: FONT_SIZE.body,
      fontWeight: '700',
      color: theme.surface.foreground,
    },
    why: {
      fontSize: FONT_SIZE.body,
      lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.surfaceMuted.foreground,
    },
    warning: {
      fontSize: FONT_SIZE.body,
      lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.surfaceMuted.foreground,
    },
  });
