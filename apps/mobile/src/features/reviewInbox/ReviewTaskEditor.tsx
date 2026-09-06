/**
 * Completing one review task.
 *
 * Spec references: `04` Phase 8.3 (completing a task updates the relevant authoritative record),
 * `18` (48dp targets, a visible label per control, the reason stated, one primary action),
 * DEC-027, trap 16.
 *
 * The form definition, the words and the rule about what makes a completion valid all live in the
 * packages, under test. This renders them and holds what the user typed. It has no "Done" button
 * and no way to reach one: the save control is disabled until the form would produce at least one
 * change, and the same function decides that as builds the payload.
 */

import { useMemo, useState } from 'react';
import { View, Text, TextInput, StyleSheet, Pressable } from 'react-native';
import {
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  MIN_TOUCH_TARGET_DP,
  describeReviewTask,
  taskForm,
  type EditableField,
  type Theme,
} from '@kynviora/presentation';
import type { ReviewTaskKind } from '@kynviora/domain';
import { buildCompletion, type FormValues, type ReviewTaskCompletion } from '@kynviora/contracts';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import type { ScreenState as ScreenStateKind } from '@kynviora/presentation';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';

export interface ReviewTaskEditorProps {
  readonly kind: ReviewTaskKind;
  readonly subjectId: string;
  readonly subjectLabel: string | null;
  /** Injected so the recorded instant is the caller's clock, never ambient time (DEC-003). */
  readonly now: string;
  readonly onSubmit: (completion: ReviewTaskCompletion) => void;
  readonly onCancel: () => void;
  /** A state to show instead of the form - saving, offline, refused. */
  readonly state?: ScreenStateKind | null;
  readonly stateMessage?: string | null;
  readonly onRetry?: () => void;
}

export function ReviewTaskEditor({
  kind,
  subjectId,
  subjectLabel,
  now,
  onSubmit,
  onCancel,
  state,
  stateMessage,
  onRetry,
}: ReviewTaskEditorProps) {
  const styles = useThemedStyles(makeStyles);
  const [values, setValues] = useState<FormValues>({});
  const form = useMemo(() => taskForm(kind), [kind]);
  const description = describeReviewTask(kind);

  // The same function that builds the payload decides whether the button is enabled, so the
  // control cannot say yes to something the builder would refuse.
  const result = useMemo(
    () => buildCompletion({ kind, subjectId }, values, now),
    [kind, subjectId, values, now],
  );

  if (state !== undefined && state !== null && state !== 'READY') {
    return (
      <ScreenState
        state={state}
        message={stateMessage}
        {...(onRetry === undefined ? {} : { onRetry })}
      />
    );
  }

  const setValue = (field: string, value: string | null | undefined) => {
    setValues((current) => ({ ...current, [field]: value }));
  };

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        {description.label}
      </Text>
      {subjectLabel === null ? null : <Text style={styles.subject}>{subjectLabel}</Text>}
      <Text style={styles.meaning}>{description.meaning}</Text>

      {/* Some tasks name a record only guided capture can produce - a batch, a formulation. The
          form offers nothing for those rather than a control that always fails, and says what is
          actually needed (`DEV-024`). */}
      {form.completableHere ? null : <Text style={styles.blocked}>{form.needsCapture}</Text>}

      {form.fields.map((field) => (
        <FieldControl
          key={field.field}
          field={field}
          value={values[field.field]}
          onChange={(value) => {
            setValue(field.field, value);
          }}
        />
      ))}

      {form.completableHere ? (
        <>
          {/* Exit criterion 2, said before the button rather than after a refusal. */}
          <Text style={styles.note}>{form.completionNote}</Text>

          {/* Why the button is disabled, whenever it is. `12` requires the user to be told what
              they can do next rather than left to guess at a greyed-out control. */}
          {result.ok ? null : (
            <Text accessibilityLiveRegion="polite" style={styles.blocked}>
              {result.refusal.message}
            </Text>
          )}

          <PrimaryButton
            label={description.actionLabel}
            disabled={!result.ok}
            accessibilityHint={form.completionNote}
            onPress={() => {
              if (result.ok) onSubmit(result.completion);
            }}
          />
        </>
      ) : null}

      <PrimaryButton
        label={form.completableHere ? 'Not now' : 'Back'}
        variant="secondary"
        onPress={onCancel}
      />
    </View>
  );
}

function FieldControl({
  field,
  value,
  onChange,
}: {
  readonly field: EditableField;
  readonly value: string | null | undefined;
  readonly onChange: (value: string | null | undefined) => void;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  // A confirmation, not an entry: the device already knows the date, and asking someone to type
  // today's is asking for something for no reason.
  if (field.input === 'TIMESTAMP_NOW') {
    const confirmed = value !== undefined;
    return (
      <View style={styles.field}>
        <Text style={styles.help}>{field.help}</Text>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: confirmed }}
          accessibilityLabel={field.label}
          accessibilityHint={field.help}
          onPress={() => {
            onChange(confirmed ? undefined : '');
          }}
          style={[
            styles.confirm,
            {
              backgroundColor: confirmed ? theme.positive.background : theme.surface.background,
              borderColor: confirmed ? theme.positive.border : theme.surface.border,
            },
          ]}
        >
          {/* The tick duplicates the accessibilityState, so meaning is never carried by the
              colour of the surface alone (`18`). */}
          <Text style={styles.confirmLabel}>
            {confirmed ? '✓  ' : ''}
            {field.label}
          </Text>
        </Pressable>
      </View>
    );
  }

  if (field.input === 'CHOICE') {
    return (
      <View style={styles.field}>
        <Text style={styles.label}>{field.label}</Text>
        <Text style={styles.help}>{field.help}</Text>
        {field.choices.map((choice) => {
          const selected = value === choice.value;
          return (
            <Pressable
              key={choice.value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={choice.label}
              onPress={() => {
                onChange(selected ? undefined : choice.value);
              }}
              style={[
                styles.choice,
                {
                  backgroundColor: selected
                    ? theme.informational.background
                    : theme.surface.background,
                  borderColor: selected ? theme.informational.border : theme.surface.border,
                },
              ]}
            >
              <Text style={styles.choiceLabel}>
                {selected ? '●  ' : '○  '}
                {choice.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    );
  }

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{field.label}</Text>
      <Text style={styles.help}>{field.help}</Text>
      <TextInput
        accessibilityLabel={field.label}
        accessibilityHint={field.help}
        value={value ?? ''}
        onChangeText={(text) => {
          onChange(text);
        }}
        keyboardType={field.input === 'NUMBER' ? 'numeric' : 'default'}
        style={styles.input}
      />
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      gap: SPACING.md,
      padding: SPACING.md,
      borderWidth: 1,
      borderRadius: SPACING.sm,
      borderColor: theme.surface.border,
      backgroundColor: theme.surface.background,
    },
    heading: {
      fontSize: FONT_SIZE.title,
      fontWeight: '600',
      color: theme.surface.foreground,
    },
    subject: { fontSize: FONT_SIZE.caption, color: theme.surfaceMuted.foreground },
    meaning: {
      fontSize: FONT_SIZE.body,
      lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.normal,
      color: theme.surface.foreground,
    },
    field: { gap: SPACING.xs },
    label: {
      fontSize: FONT_SIZE.body,
      fontWeight: '600',
      color: theme.surface.foreground,
    },
    help: {
      fontSize: FONT_SIZE.caption,
      lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.surfaceMuted.foreground,
    },
    input: {
      minHeight: MIN_TOUCH_TARGET_DP,
      borderWidth: 1,
      borderRadius: SPACING.sm,
      borderColor: theme.surface.border,
      paddingHorizontal: SPACING.md,
      fontSize: FONT_SIZE.body,
      color: theme.surface.foreground,
    },
    choice: {
      minHeight: MIN_TOUCH_TARGET_DP,
      justifyContent: 'center',
      borderWidth: 1,
      borderRadius: SPACING.sm,
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.sm,
    },
    choiceLabel: {
      fontSize: FONT_SIZE.body,
      lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.normal,
      color: theme.surface.foreground,
    },
    confirm: {
      minHeight: MIN_TOUCH_TARGET_DP,
      justifyContent: 'center',
      borderWidth: 1,
      borderRadius: SPACING.sm,
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.sm,
    },
    confirmLabel: {
      fontSize: FONT_SIZE.body,
      fontWeight: '600',
      color: theme.surface.foreground,
    },
    note: {
      fontSize: FONT_SIZE.caption,
      lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.surfaceMuted.foreground,
    },
    blocked: {
      fontSize: FONT_SIZE.caption,
      lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.attention.foreground,
    },
  });
