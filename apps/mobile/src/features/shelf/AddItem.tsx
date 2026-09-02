/**
 * Writing down a pack somebody is holding.
 *
 * Spec references: `04` Phase 2.2 (manual medicine entry - "a user can create a clinically useful
 * current medicine record entirely manually"; "missing fields remain explicitly unknown rather
 * than receiving defaults"), `04` Phase 2.3 (manual personal-care entry - "personal-care data is
 * not reduced to name + barcode"), `18` (48dp targets, a label always present, meaning never
 * carried by colour alone), `10` (state the limits where you state the findings), `13`, `02`.
 *
 * THIS SCREEN COMPOSES NOTHING
 * Every label, every piece of help text and every sentence about what a blank field costs comes
 * from `@kynviora/presentation`, and the form's field list decides which fields exist for which
 * category. `apps/**` is outside the test run (`BLK-002`), so copy written here would be the one
 * family of user-visible strings nothing ever scans.
 *
 * ONE REQUIRED FIELD, AND NOTHING MARKED RECOMMENDED
 * Phase 2.2's first exit criterion. A person holding a box in a kitchen has a name and may have
 * nothing else to hand. Every other field says it is optional and none is starred, badged or
 * ordered by importance: a form that scolded somebody for leaving the batch code blank would
 * collect guessed batch codes, and a guessed batch code is worse than an absent one.
 *
 * NOTHING TYPED HERE IS REPAIRED
 * The values go up exactly as typed. The server refuses a malformed one and names the field, and
 * this screen points at it. A market this screen had silently upper-cased is one the person can
 * no longer check against the pack in their hand.
 *
 * ONE KEY PER DRAFT, NOT PER PRESS
 * `13` requires the server to commit exactly once. The key is generated when the form opens and
 * kept for every attempt on that draft, so a person on a bad connection tapping Save twice gets
 * one medicine record - and a submission the server refused leaves the key unused, so correcting
 * a field and trying again is the same save rather than a second one.
 */

import { useCallback, useMemo, useState } from 'react';
import { View, Text, TextInput, StyleSheet, Pressable } from 'react-native';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  MIN_TOUCH_TARGET_DP,
  manualEntryForm,
  type ManualField,
  type ScreenState as ScreenStateKind,
} from '@kynviora/presentation';
import type { ItemKind } from '@kynviora/domain';
import {
  manualEntryDraft,
  messageForFailure,
  screenStateForFailure,
  type ItemCreated,
} from '@kynviora/contracts';
import { useApi } from '@/api/ApiProvider';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';

export interface AddItemProps {
  readonly itemKind: ItemKind;
  readonly profileId: string;
  /** Called once an item exists, so the shelf re-reads rather than drawing a row it invented. */
  readonly onSaved: () => void;
  readonly onClose: () => void;
}

export function AddItem({ itemKind, profileId, onSaved, onClose }: AddItemProps) {
  const { client } = useApi();

  const form = useMemo(() => manualEntryForm(itemKind), [itemKind]);

  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [state, setState] = useState<ScreenStateKind | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** The field the server's refusal was about, so the form can point at it rather than guess. */
  const [refusedField, setRefusedField] = useState<string | null>(null);
  const [created, setCreated] = useState<ItemCreated | null>(null);

  // Generated once for this draft. See the module note - regenerating it per press is not an
  // idempotency key, it is a second medicine record.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const onSave = useCallback(() => {
    if (client === null) return;

    setState('LOADING');
    setMessage(null);
    setRefusedField(null);

    void client.createItem(manualEntryDraft({ profileId, itemKind, values }), idempotencyKey).then(
      (outcome) => {
        if (outcome.kind === 'OK') {
          setState(null);
          setCreated(outcome.value);
          onSaved();
          return;
        }
        setState(screenStateForFailure(outcome));
        setMessage(messageForFailure(outcome));
        // The domain names the field it refused. Read as a value rather than parsed out of the
        // message, because `13` says clients branch on codes and never on message text.
        const field = outcome.kind === 'REFUSED' ? outcome.detail?.['field'] : undefined;
        setRefusedField(typeof field === 'string' ? field : null);
      },
      () => {
        setState('RECOVERABLE_ERROR');
        setMessage(null);
      },
    );
  }, [client, profileId, itemKind, values, idempotencyKey, onSaved]);

  // What exists now, and what it cannot do yet. Said here rather than while typing: during entry
  // it reads as a scold, and afterwards it is `10`'s obligation met while the person can still
  // act on it - before the first time an alert fails to arrive and nobody knows why.
  if (created !== null) {
    return (
      <View style={styles.container}>
        <Text accessibilityRole="header" style={styles.heading}>
          {created.heading}
        </Text>

        {created.completeNote === null ? null : (
          <Text style={styles.body}>{created.completeNote}</Text>
        )}

        {created.limits.length === 0 ? null : (
          <View style={styles.block}>
            <Text accessibilityRole="header" style={styles.subheading}>
              What this record cannot do yet
            </Text>
            {/* No count and no ordering by importance. `02` forbids the aggregate, and a record
                somebody left sparse on purpose is not a worse record. */}
            {created.limits.map((limit, index) => (
              <Text key={`limit-${String(index)}`} style={styles.body}>
                {limit}
              </Text>
            ))}
          </View>
        )}

        <Text style={styles.help}>{created.note}</Text>

        <PrimaryButton label="Done" onPress={onClose} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        {form.heading}
      </Text>
      {/* At the top rather than discovered on the way down. A person who has to reach the bottom
          to learn only the name is needed has already decided the form is too long. */}
      <Text style={styles.body}>{form.intro}</Text>

      {state !== null ? <ScreenState state={state} message={message} /> : null}

      {form.fields.map((field) => (
        <Field
          key={field.field}
          field={field}
          value={values[field.field] ?? ''}
          refused={refusedField === field.field}
          onChange={(next) => {
            setValues((current) => ({ ...current, [field.field]: next }));
          }}
        />
      ))}

      {/* Why nothing here will show as confirmed. A person reading "not confirmed" with no
          explanation would reasonably think Kynviora doubted them. */}
      <Text style={styles.help}>{form.verificationNote}</Text>

      <PrimaryButton
        label="Save"
        accessibilityHint="Adds this to the shelf. You can add anything missing later."
        disabled={state === 'LOADING'}
        onPress={onSave}
      />
      <PrimaryButton label="Cancel" variant="secondary" onPress={onClose} />
    </View>
  );
}

function Field({
  field,
  value,
  refused,
  onChange,
}: {
  readonly field: ManualField;
  readonly value: string;
  readonly refused: boolean;
  readonly onChange: (next: string) => void;
}) {
  // The label carries what the styling carries. `18` forbids meaning conveyed by colour alone, so
  // an optional field says so in words and a refused one is named rather than only outlined.
  const suffix = field.required ? '' : ' (optional)';

  if (field.input === 'CHOICE') {
    return (
      <View style={[styles.field, refused ? styles.fieldRefused : null]}>
        <Text style={styles.label}>{`${field.label}${suffix}`}</Text>
        <Text style={styles.help}>{field.help}</Text>
        {field.choices.map((choice) => {
          const chosen = value === choice.value;
          return (
            <Pressable
              key={choice.value}
              accessibilityRole="radio"
              accessibilityState={{ selected: chosen }}
              accessibilityLabel={choice.label}
              onPress={() => {
                // Pressing the chosen one again clears it. Nothing is preselected and a category
                // is optional, so there has to be a way back to having said nothing.
                onChange(chosen ? '' : choice.value);
              }}
              style={[styles.choice, chosen ? styles.choiceOn : null]}
            >
              <Text style={styles.choiceLabel}>
                {chosen ? `${choice.label} - chosen` : choice.label}
              </Text>
            </Pressable>
          );
        })}
        {value === '' ? <Text style={styles.absent}>{field.absentNote}</Text> : null}
      </View>
    );
  }

  const multiline = field.input === 'LONG_TEXT';

  return (
    <View style={[styles.field, refused ? styles.fieldRefused : null]}>
      <Text style={styles.label}>{`${field.label}${suffix}`}</Text>
      <Text style={styles.help}>{field.help}</Text>
      <TextInput
        accessibilityLabel={`${field.label}${suffix}`}
        accessibilityHint={field.help}
        value={value}
        onChangeText={onChange}
        // No autocorrect and no autocapitalise anywhere on this form. A barcode, a lot code and a
        // market are transcriptions, and a keyboard that "helps" with them produces a value that
        // no longer matches the pack. The two long fields are somebody else's words for the same
        // reason - `04` Phase 4.1 preserves a written direction as source text.
        autoCorrect={false}
        autoCapitalize="none"
        multiline={multiline}
        // A calendar date, not an instant: an expiry printed on a box has no time of day.
        placeholder={field.input === 'DATE' ? 'YYYY-MM-DD' : undefined}
        style={[styles.input, multiline ? styles.multiline : null]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: SPACING.md },
  block: { gap: SPACING.xs },
  heading: {
    fontSize: FONT_SIZE.title,
    fontWeight: '700',
    color: LIGHT_THEME.surface.foreground,
  },
  subheading: {
    fontSize: FONT_SIZE.body,
    fontWeight: '600',
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
  absent: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
    fontStyle: 'italic',
  },
  field: {
    gap: SPACING.xs,
    padding: SPACING.md,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
    backgroundColor: LIGHT_THEME.surface.background,
  },
  // `attention`, not `action`. `action` is the tone a recall wears, and giving it to a mistyped
  // barcode is the alarm optimisation `02` refuses - it makes the red mean less where it matters.
  fieldRefused: {
    borderColor: LIGHT_THEME.attention.border,
    backgroundColor: LIGHT_THEME.attention.background,
  },
  label: {
    fontSize: FONT_SIZE.body,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
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
  multiline: { minHeight: MIN_TOUCH_TARGET_DP * 2, textAlignVertical: 'top' },
  choice: {
    minHeight: MIN_TOUCH_TARGET_DP,
    justifyContent: 'center',
    paddingHorizontal: SPACING.md,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
    backgroundColor: LIGHT_THEME.surface.background,
  },
  choiceOn: {
    borderColor: LIGHT_THEME.informational.border,
    backgroundColor: LIGHT_THEME.informational.background,
  },
  choiceLabel: {
    fontSize: FONT_SIZE.body,
    color: LIGHT_THEME.surface.foreground,
  },
});
