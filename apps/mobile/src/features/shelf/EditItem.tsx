/**
 * Changing what is recorded about an item, and putting one out of use.
 *
 * Spec references: `04` Stage 2 stage output ("create, view, update, archive, and review"), `04`
 * Phase 2.1 (common item lifecycle), `13` (`owned_item`'s conflict policy is `ASK_USER`), `10`,
 * `18`, `02`, `09`.
 *
 * THREE THINGS, ONE SCREEN, IN THE ORDER SOMEBODY WANTS THEM
 * Correcting a field is the common case and comes first. Saying you have checked it is one tap.
 * Putting the item out of use is last, because it is the one with consequences a person cannot
 * see, and it is introduced by what each choice stops rather than only by what it records.
 *
 * THE SAME FORM AS CREATING ONE
 * `manualEntryForm` decides which fields exist for which category, so an edit cannot offer a
 * field a creation could not, and a field added later appears on both. The values are prefilled
 * from `editableValues`, which the server keys the same way - a form built from the rendered
 * labels would have to match on label text.
 *
 * A BLANK FIELD IS A REAL ANSWER HERE
 * On creation, blank means "not entered". On an edit, blank means "empty this", because there has
 * to be a way to un-enter something somebody typed by mistake. That is why this screen sends
 * `null` where the manual-entry screen simply omits the field.
 *
 * NOTHING IS APPLIED LOCALLY
 * `12` allows optimistic application only for low-risk changes, and `13` makes this entity
 * `ASK_USER`: the version is sent, the server decides, and the screen re-reads. A row this screen
 * drew itself would survive a conflict it did not notice.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, StyleSheet, Pressable } from 'react-native';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  MIN_TOUCH_TARGET_DP,
  ITEM_UPDATE_COPY,
  lifecycleActions,
  manualEntryForm,
  type ManualField,
  type ScreenState as ScreenStateKind,
} from '@kynviora/presentation';
import type { ItemLifecycleState } from '@kynviora/domain';
import {
  messageForFailure,
  screenStateForFailure,
  type ItemDetailScreenView,
  type ItemUpdateBody,
} from '@kynviora/contracts';
import { useApi } from '@/api/ApiProvider';
import { usePendingSync } from '@/sync/PendingSyncProvider';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';

export interface EditItemProps {
  readonly view: ItemDetailScreenView;
  /** Called after any successful change, so the detail is re-read rather than patched here. */
  readonly onChanged: () => void;
  readonly onClose: () => void;
}

export function EditItem({ view, onChanged, onClose }: EditItemProps) {
  const { client } = useApi();
  const { queue: queueEdit, registerSender } = usePendingSync();

  const form = useMemo(() => manualEntryForm(view.itemKind), [view.itemKind]);

  const prefill = useCallback(
    (): Readonly<Record<string, string>> =>
      Object.fromEntries(
        form.fields.map((field) => [field.field, view.editableValues[field.field] ?? '']),
      ),
    [form.fields, view.editableValues],
  );

  /** Prefilled from the server's answer. An absent value is an empty field, which is the truth. */
  const [values, setValues] = useState<Readonly<Record<string, string>>>(prefill);
  const [stoppedOn, setStoppedOn] = useState(view.stoppedOn ?? '');

  const [state, setState] = useState<ScreenStateKind | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [refusedField, setRefusedField] = useState<string | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  /**
   * The server refused because the form matched what is already stored.
   *
   * Kept apart from the error state. Opening the form, changing nothing and pressing Save is an
   * ordinary thing to do, and answering it with the same red panel a malformed barcode gets would
   * teach somebody that this screen fails - which is how a person stops reading the panel on the
   * occasion it says something that matters.
   */
  const [unchanged, setUnchanged] = useState(false);
  /** Set where the person chose to take the saved version over what they had typed. */
  const [reloaded, setReloaded] = useState(false);

  /**
   * How a queued item edit is sent when the drain reaches it.
   *
   * Only `UPDATE`. A queued `CREATE` would reach Phase 8.5's reconciliation as a second copy of
   * one medicine (`DEV-038`), and nothing here should quietly acquire that behaviour by handling
   * a mutation it was never wired to queue.
   */
  useEffect(() => {
    if (client === null) return;
    registerSender('owned_item', async (operation) => {
      if (operation.mutation !== 'UPDATE') {
        return {
          kind: 'REFUSED',
          code: 'VALIDATION_FAILED',
          message: 'Unsupported offline change.',
          retryable: false,
          correlationId: null,
        };
      }
      return client.updateItem(operation.entityId, operation.payload as ItemUpdateBody);
    });
  }, [client, registerSender]);

  const send = useCallback(
    (body: ItemUpdateBody, note: string) => {
      if (client === null) return;

      setState('LOADING');
      setMessage(null);
      setRefusedField(null);
      setConflicted(false);
      setUnchanged(false);
      setReloaded(false);
      setSaved(null);

      void client.updateItem(view.id, body).then(
        (outcome) => {
          if (outcome.kind === 'OK') {
            setState(null);
            setSaved(note);
            // Re-read rather than patched. What stands after a write is the server's answer, and
            // the version this screen holds has moved.
            onChanged();
            return;
          }

          if (outcome.kind === 'REFUSED' && outcome.detail?.['reason_code'] === 'no_change') {
            // Not a failure. Told apart by the reason code rather than by the message text (`13`).
            setState(null);
            setUnchanged(true);
            return;
          }

          // Queued rather than lost, for the one failure that says nothing about the edit.
          // `owned_item` resolves `ASK_USER` under `13`, so it may be applied before the server
          // has agreed - and unlike a create, an update cannot produce a second copy of a
          // medicine, which is the reason `DEV-038` still holds creation back. The write is
          // conditional on `expectedVersion`, so a replay either lands once or comes back as a
          // conflict.
          if (outcome.kind === 'OFFLINE') {
            void queueEdit({
              entityType: 'owned_item',
              entityId: view.id,
              mutation: 'UPDATE',
              payload: body,
              baseVersion: body.expectedVersion,
            }).then((queued) => {
              setState(queued ? null : screenStateForFailure(outcome));
              setMessage(queued ? null : messageForFailure(outcome));
              if (queued) setSaved(note);
            });
            return;
          }

          setState(screenStateForFailure(outcome));
          setMessage(messageForFailure(outcome));

          if (outcome.kind === 'REFUSED') {
            // Told apart by code, never by message text (`13`). A conflict is not something the
            // person did wrong, and pointing at a field for it would say it was.
            setConflicted(outcome.code === 'VERSION_CONFLICT');
            const field = outcome.detail?.['field'];
            setRefusedField(typeof field === 'string' ? field : null);
            if (outcome.code === 'VERSION_CONFLICT') onChanged();
          }
        },
        () => {
          setState('RECOVERABLE_ERROR');
          setMessage(null);
        },
      );
    },
    [client, view.id, onChanged],
  );

  const onSaveFields = useCallback(() => {
    // Everything the form offers is sent, because on an edit a blank field is "empty this" rather
    // than "leave it alone" - and the two have to be distinguishable for a mistyped value to be
    // removable at all. The name is the exception: it cannot be cleared, so it goes as a string.
    const body: Record<string, string | null> = {};
    for (const field of form.fields) {
      if (field.field === 'displayName') continue;
      const typed = values[field.field] ?? '';
      body[field.field] = typed.trim() === '' ? null : typed;
    }

    send(
      {
        expectedVersion: view.version,
        displayName: values['displayName'] ?? '',
        ...body,
      },
      ITEM_UPDATE_COPY.savedNote,
    );
  }, [form.fields, values, view.version, send]);

  const onMarkReviewed = useCallback(() => {
    send({ expectedVersion: view.version, markReviewed: true }, ITEM_UPDATE_COPY.reviewedNote);
  }, [view.version, send]);

  const onLifecycle = useCallback(
    (state_: ItemLifecycleState) => {
      send(
        {
          expectedVersion: view.version,
          lifecycleState: state_,
          // Only ever sent where it is meaningful. `ACTIVE` clears it on the server and
          // `ARCHIVED` refuses one, so offering the field on either would be offering a value
          // that could only be rejected.
          ...(state_ === 'STOPPED' && stoppedOn.trim() !== '' ? { stoppedOn } : {}),
        },
        ITEM_UPDATE_COPY.savedNote,
      );
    },
    [view.version, stoppedOn, send],
  );

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        {ITEM_UPDATE_COPY.editHeading}
      </Text>
      <Text style={styles.body}>{ITEM_UPDATE_COPY.editIntro}</Text>

      {conflicted ? (
        <View style={styles.conflict}>
          <Text accessibilityRole="header" style={styles.subheading}>
            {ITEM_UPDATE_COPY.conflictHeading}
          </Text>
          <Text style={styles.body}>{ITEM_UPDATE_COPY.conflictBody}</Text>
          {/* Taking the other version is something the person does, not something that happens to
              them. `13`'s policy for this entity is ASK_USER, and replacing the form silently
              would answer the question on their behalf - the same failure as overwriting the
              other change. The detail was re-read when the conflict arrived, so `view` already
              holds what the record says. */}
          <PrimaryButton
            label={ITEM_UPDATE_COPY.conflictLoadLabel}
            accessibilityHint={ITEM_UPDATE_COPY.conflictLoadHint}
            variant="secondary"
            onPress={() => {
              setValues(prefill());
              setStoppedOn(view.stoppedOn ?? '');
              setConflicted(false);
              setReloaded(true);
            }}
          />
        </View>
      ) : null}

      {reloaded ? <Text style={styles.help}>{ITEM_UPDATE_COPY.conflictLoadedNote}</Text> : null}

      {state !== null ? <ScreenState state={state} message={message} /> : null}
      {saved === null ? null : <Text style={styles.saved}>{saved}</Text>}
      {unchanged ? <Text style={styles.help}>{ITEM_UPDATE_COPY.unchangedNote}</Text> : null}

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

      <PrimaryButton label="Save changes" disabled={state === 'LOADING'} onPress={onSaveFields} />

      {/* One tap, and its own control. Folded into "save changes" it would record a check
          somebody did not make every time they corrected a typo. */}
      <View style={styles.block}>
        <Text style={styles.label}>{ITEM_UPDATE_COPY.reviewLabel}</Text>
        <Text style={styles.help}>{ITEM_UPDATE_COPY.reviewHelp}</Text>
        <PrimaryButton
          label={ITEM_UPDATE_COPY.reviewLabel}
          variant="secondary"
          disabled={state === 'LOADING'}
          onPress={onMarkReviewed}
        />
      </View>

      {/* Last, and introduced by what each choice stops. `10`: the limits go where the person is
          making the decision, not underneath the control they have already pressed. */}
      {view.lifecycleState === null ? null : (
        <View style={styles.block}>
          <Text accessibilityRole="header" style={styles.subheading}>
            {ITEM_UPDATE_COPY.lifecycleHeading}
          </Text>
          <Text style={styles.help}>{ITEM_UPDATE_COPY.lifecycleIntro}</Text>

          {/* Offered only where it means something - see `onLifecycle`. */}
          {view.lifecycleState === 'STOPPED' ? null : (
            <View style={styles.field}>
              <Text style={styles.label}>When did you stop? (optional)</Text>
              <Text style={styles.help}>
                Leave it blank if you do not remember. Kynviora will not guess a date.
              </Text>
              <TextInput
                accessibilityLabel="When did you stop, optional"
                value={stoppedOn}
                onChangeText={setStoppedOn}
                autoCorrect={false}
                autoCapitalize="none"
                placeholder="YYYY-MM-DD"
                style={styles.input}
              />
            </View>
          )}

          {lifecycleActions(view.lifecycleState).map((action) => (
            <View key={action.state} style={styles.field}>
              <Text style={styles.label}>{action.label}</Text>
              <Text style={styles.body}>{action.description}</Text>
              {/* What Kynviora stops doing. Above the control, never under it. */}
              <Text style={styles.stops}>{action.stops}</Text>
              <PrimaryButton
                label={action.label}
                accessibilityHint={action.accessibilityHint}
                variant="secondary"
                disabled={state === 'LOADING'}
                onPress={() => {
                  onLifecycle(action.state);
                }}
              />
            </View>
          ))}
        </View>
      )}

      <PrimaryButton label="Done" variant="secondary" onPress={onClose} />
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
        // No autocorrect and no autocapitalise, for the reason the entry form has none: these are
        // transcriptions, and a keyboard that "helps" produces a value that no longer matches the
        // pack.
        autoCorrect={false}
        autoCapitalize="none"
        multiline={multiline}
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
  stops: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.attention.foreground,
  },
  saved: {
    fontSize: FONT_SIZE.body,
    color: LIGHT_THEME.positive.foreground,
  },
  conflict: {
    gap: SPACING.xs,
    padding: SPACING.md,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.attention.border,
    backgroundColor: LIGHT_THEME.attention.background,
  },
  field: {
    gap: SPACING.xs,
    padding: SPACING.md,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
    backgroundColor: LIGHT_THEME.surface.background,
  },
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
