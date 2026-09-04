/**
 * Setting when a medicine is taken.
 *
 * Spec references: `04` Phase 4.1 (the schedule a person enters), `04` Phase 4.2 (what the
 * reminder will say and whether it will arrive), `18` (a label is always present, 48dp targets,
 * meaning never carried by colour, no shame), `09`, `13`, `12`.
 *
 * THIS COMPONENT DECIDES NOTHING
 * Every sentence comes from `SCHEDULE_COPY` and `REMINDER_DISCLOSURE_COPY` in
 * `@kynviora/presentation`; every value change and every refusal comes from `scheduleForm.ts` in
 * `@kynviora/contracts`. `apps/**` is outside the test run, and what would otherwise be decided
 * here - whether a time is acceptable, what a reminder will disclose - is exactly the class of
 * decision that must not live where nothing checks it.
 *
 * THE DIRECTIONS ARE QUOTED, NOT INTERPRETED
 * A person setting times needs to see what the prescriber wrote, and it is rendered as a quotation
 * in its own voice. `09` forbids Kynviora restating a clinical instruction, and working times out
 * of "one tablet twice a day" is the person's job. The screen says so.
 *
 * THE DISCLOSURE SENTENCE IS ABOVE THE SAVE CONTROL
 * Not under it, and not on a settings screen somewhere else. Somebody deciding whether to rely on
 * reminders is entitled to know what will appear on their locked screen *before* they commit to
 * it - the same placement rule the archive control follows (DEC-084).
 */

import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  FONT_SIZE,
  LIGHT_THEME,
  LINE_HEIGHT_MULTIPLIER,
  MIN_TOUCH_TARGET_DP,
  REMINDER_DISCLOSURE_COPY,
  SCHEDULE_COPY,
  SPACING,
  describeSchedule,
  scheduleKindOptions,
  weekdayOptions,
  type ScreenState as ScreenStateKind,
} from '@kynviora/presentation';
import {
  emptyScheduleForm,
  scheduleBodyFrom,
  scheduleChangeBodyFrom,
  scheduleFormFrom,
  scheduleFormRefusal,
  withDayToggled,
  withKindChanged,
  withTimeAdded,
  withTimeChanged,
  withTimeRemoved,
  type Schedule,
  type ScheduleBody,
  type ScheduleChangeBody,
  type ScheduleFormValues,
} from '@kynviora/contracts';
import type { IsoWeekday, NotificationDetailLevel, ScheduleKind } from '@kynviora/domain';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';

export interface MedicineSchedulesProps {
  readonly displayName: string;
  /** The prescriber's or the label's own words, or `null`. Rendered verbatim. */
  readonly directionsText: string | null;
  readonly schedules: readonly Schedule[];
  readonly listState: ScreenStateKind;
  /** What a reminder would put on a locked screen right now. */
  readonly detailLevel: NotificationDetailLevel;
  /** Whether the phone will show a reminder at all. */
  readonly remindersPermitted: boolean;
  /** The device's zone, used for a new schedule. Read by the caller, which may touch the platform. */
  readonly deviceTimeZone: string;
  /** Whether this caller may change the schedule. Absent controls, never disabled ones (DEC-045). */
  readonly mayEdit: boolean;
  readonly onCreate: (body: ScheduleBody) => void;
  readonly onUpdate: (scheduleId: string, body: ScheduleChangeBody) => void;
  readonly onClose: () => void;
  readonly state?: ScreenStateKind | null;
  readonly stateMessage?: string | null;
}

export function MedicineSchedules({
  displayName,
  directionsText,
  schedules,
  listState,
  detailLevel,
  remindersPermitted,
  deviceTimeZone,
  mayEdit,
  onCreate,
  onUpdate,
  onClose,
  state,
  stateMessage,
}: MedicineSchedulesProps) {
  /** The schedule being edited, or `'NEW'`, or nothing. */
  const [editing, setEditing] = useState<Schedule | 'NEW' | null>(null);
  const [values, setValues] = useState<ScheduleFormValues>(() => emptyScheduleForm(deviceTimeZone));

  const refusal = useMemo(() => scheduleFormRefusal(values), [values]);

  const startNew = () => {
    setValues(emptyScheduleForm(deviceTimeZone));
    setEditing('NEW');
  };

  const startEdit = (schedule: Schedule) => {
    setValues(scheduleFormFrom(schedule));
    setEditing(schedule);
  };

  if (editing !== null) {
    return (
      <View style={styles.container}>
        <Text accessibilityRole="header" style={styles.heading}>
          {SCHEDULE_COPY.heading}
        </Text>
        <Text style={styles.name}>{displayName}</Text>
        <Text style={styles.body}>{SCHEDULE_COPY.intro}</Text>

        {/* Somebody else's words, in their own voice. `09`. */}
        <Text style={styles.label}>{SCHEDULE_COPY.directionsLabel}</Text>
        <Text style={styles.help}>{SCHEDULE_COPY.directionsHelp}</Text>
        {directionsText === null ? (
          <Text style={styles.absent}>{SCHEDULE_COPY.directionsMissing}</Text>
        ) : (
          <Text style={styles.quotation}>{directionsText}</Text>
        )}

        <Text style={styles.label}>{SCHEDULE_COPY.patternLabel}</Text>
        {scheduleKindOptions().map((option) => (
          <ChoiceRow
            key={option.kind}
            label={option.label}
            description={option.description}
            selected={values.scheduleKind === option.kind}
            onPress={() => {
              setValues((current) => withKindChanged(current, option.kind));
            }}
          />
        ))}

        {values.scheduleKind === 'AS_NEEDED' ? (
          <Text style={styles.help}>{SCHEDULE_COPY.asNeededNote}</Text>
        ) : (
          <>
            <Text style={styles.label}>{SCHEDULE_COPY.timesLabel}</Text>
            <Text style={styles.help}>{SCHEDULE_COPY.timesHelp}</Text>
            {values.timesLocal.map((time, index) => (
              // The index is the identity: two lines can hold the same text while somebody is
              // typing, and a key on the value would make them the same row. (There is no
              // `react/no-array-index-key` to silence: the plugin declaring it is not installed,
              // and a disable comment for a rule nothing runs is a decision nobody is enforcing.)
              <View key={`time-${String(index)}`} style={styles.timeRow}>
                <TextInput
                  accessibilityLabel={`${SCHEDULE_COPY.timesLabel} ${String(index + 1)}`}
                  value={time}
                  onChangeText={(next) => {
                    setValues((current) => withTimeChanged(current, index, next));
                  }}
                  placeholder="08:00"
                  keyboardType="numbers-and-punctuation"
                  style={styles.timeInput}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={SCHEDULE_COPY.removeTimeLabel}
                  style={styles.removeTime}
                  onPress={() => {
                    setValues((current) => withTimeRemoved(current, index));
                  }}
                >
                  <Text style={styles.removeTimeLabel}>Remove</Text>
                </Pressable>
              </View>
            ))}
            <PrimaryButton
              label={SCHEDULE_COPY.addTimeLabel}
              variant="secondary"
              onPress={() => {
                setValues((current) => withTimeAdded(current));
              }}
            />
          </>
        )}

        {values.scheduleKind !== 'SELECTED_DAYS' ? null : (
          <>
            <Text style={styles.label}>{SCHEDULE_COPY.daysLabel}</Text>
            <Text style={styles.help}>{SCHEDULE_COPY.daysHelp}</Text>
            <View style={styles.days}>
              {weekdayOptions().map((day) => {
                const selected = values.daysOfWeek.includes(day.day);
                return (
                  <Pressable
                    key={day.day}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: selected }}
                    accessibilityLabel={day.accessibilityLabel}
                    style={[styles.day, selected ? styles.daySelected : null]}
                    onPress={() => {
                      setValues((current) => withDayToggled(current, day.day));
                    }}
                  >
                    {/* The tick is a character, not a colour. `18`: meaning is never carried by
                        colour alone, and a selected day that differs only in background is
                        invisible to a person who cannot see the difference. */}
                    <Text style={styles.dayLabel}>{selected ? `✓ ${day.label}` : day.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </>
        )}

        <Text style={styles.label}>{SCHEDULE_COPY.timeZoneLabel}</Text>
        <Text style={styles.help}>{SCHEDULE_COPY.timeZoneHelp}</Text>
        <TextInput
          accessibilityLabel={SCHEDULE_COPY.timeZoneLabel}
          value={values.timeZone}
          onChangeText={(next) => {
            setValues((current) => ({ ...current, timeZone: next }));
          }}
          autoCapitalize="none"
          style={styles.input}
        />

        <Text style={styles.label}>{SCHEDULE_COPY.startsOnLabel}</Text>
        <Text style={styles.help}>{SCHEDULE_COPY.startsOnHelp}</Text>
        <TextInput
          accessibilityLabel={SCHEDULE_COPY.startsOnLabel}
          value={values.startsOn}
          onChangeText={(next) => {
            setValues((current) => ({ ...current, startsOn: next }));
          }}
          placeholder="2026-09-10"
          style={styles.input}
        />

        <Text style={styles.label}>{SCHEDULE_COPY.endsOnLabel}</Text>
        <Text style={styles.help}>{SCHEDULE_COPY.endsOnHelp}</Text>
        <TextInput
          accessibilityLabel={SCHEDULE_COPY.endsOnLabel}
          value={values.endsOn}
          onChangeText={(next) => {
            setValues((current) => ({ ...current, endsOn: next }));
          }}
          placeholder="2026-09-20"
          style={styles.input}
        />

        {/* Above the save control, not under it. */}
        <Text style={styles.help}>{REMINDER_DISCLOSURE_COPY[detailLevel]}</Text>
        <Text style={styles.help}>{SCHEDULE_COPY.reliability}</Text>
        {remindersPermitted ? null : (
          <Text accessibilityLiveRegion="polite" style={styles.warning}>
            {SCHEDULE_COPY.notPermitted}
          </Text>
        )}

        {refusal === null ? null : (
          <Text accessibilityLiveRegion="polite" style={styles.warning}>
            {refusal.message}
          </Text>
        )}

        <PrimaryButton
          label={editing === 'NEW' ? SCHEDULE_COPY.saveLabel : SCHEDULE_COPY.updateLabel}
          onPress={() => {
            // Re-checked at press rather than only in the disabled state, because the refusal is
            // what a person reads and a control that silently does nothing teaches them the
            // screen is broken.
            if (scheduleFormRefusal(values) !== null) return;
            if (editing === 'NEW') onCreate(scheduleBodyFrom(values));
            else onUpdate(editing.id, scheduleChangeBodyFrom(values, editing.version));
            setEditing(null);
          }}
        />

        {editing === 'NEW' || !editing.active ? null : (
          <>
            <Text style={styles.help}>{SCHEDULE_COPY.stopHelp}</Text>
            <PrimaryButton
              label={SCHEDULE_COPY.stopLabel}
              variant="secondary"
              onPress={() => {
                onUpdate(editing.id, scheduleChangeBodyFrom(values, editing.version, false));
                setEditing(null);
              }}
            />
          </>
        )}

        {state != null && state !== 'READY' ? (
          <ScreenState state={state} message={stateMessage} />
        ) : null}

        <PrimaryButton
          label="Cancel"
          variant="secondary"
          onPress={() => {
            setEditing(null);
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        {SCHEDULE_COPY.heading}
      </Text>
      <Text style={styles.name}>{displayName}</Text>

      {listState !== 'READY' && listState !== 'EMPTY' ? <ScreenState state={listState} /> : null}

      {schedules.length === 0 ? (
        <Text style={styles.body}>Nothing is scheduled for this medicine.</Text>
      ) : (
        schedules.map((schedule) => (
          <View key={schedule.id} style={styles.line}>
            <Text style={styles.body}>
              {describeSchedule({
                kind: schedule.scheduleKind as ScheduleKind,
                timesLocal: schedule.timesLocal,
                daysOfWeek: schedule.daysOfWeek as readonly IsoWeekday[] | null,
                active: schedule.active,
              })}
            </Text>
            <Text style={styles.when}>{schedule.timeZone}</Text>
            {mayEdit ? (
              <PrimaryButton
                label="Change"
                variant="secondary"
                onPress={() => {
                  startEdit(schedule);
                }}
              />
            ) : null}
          </View>
        ))
      )}

      <Text style={styles.help}>{REMINDER_DISCLOSURE_COPY[detailLevel]}</Text>
      <Text style={styles.help}>{SCHEDULE_COPY.reliability}</Text>
      {remindersPermitted ? null : <Text style={styles.warning}>{SCHEDULE_COPY.notPermitted}</Text>}

      {/* Absent rather than disabled for a caller who may only look (DEC-045). */}
      {mayEdit ? <PrimaryButton label="Add a schedule" onPress={startNew} /> : null}
      <PrimaryButton label="Done" variant="secondary" onPress={onClose} />
    </View>
  );
}

function ChoiceRow({
  label,
  description,
  selected,
  onPress,
}: {
  readonly label: string;
  readonly description: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      accessibilityHint={description}
      style={[styles.choice, selected ? styles.choiceSelected : null]}
      onPress={onPress}
    >
      {/* The marker is a character. `18`: never colour alone. */}
      <Text style={styles.choiceLabel}>{selected ? `✓ ${label}` : label}</Text>
      <Text style={styles.help}>{description}</Text>
    </Pressable>
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
  name: { fontSize: FONT_SIZE.body, fontWeight: '600', color: LIGHT_THEME.surface.foreground },
  body: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.normal,
    color: LIGHT_THEME.surface.foreground,
  },
  label: { fontSize: FONT_SIZE.body, fontWeight: '600', color: LIGHT_THEME.surface.foreground },
  help: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
  absent: { fontSize: FONT_SIZE.body, color: LIGHT_THEME.surfaceMuted.foreground },
  quotation: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.normal,
    fontStyle: 'italic',
    paddingLeft: SPACING.md,
    borderLeftWidth: 2,
    borderLeftColor: LIGHT_THEME.surface.border,
    color: LIGHT_THEME.surface.foreground,
  },
  warning: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.normal,
    color: LIGHT_THEME.attention.foreground,
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
  timeRow: { flexDirection: 'row', gap: SPACING.sm, alignItems: 'center' },
  timeInput: {
    flex: 1,
    minHeight: MIN_TOUCH_TARGET_DP,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
    paddingHorizontal: SPACING.md,
    fontSize: FONT_SIZE.body,
    color: LIGHT_THEME.surface.foreground,
  },
  removeTime: {
    minHeight: MIN_TOUCH_TARGET_DP,
    minWidth: MIN_TOUCH_TARGET_DP * 2,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.sm,
  },
  removeTimeLabel: { fontSize: FONT_SIZE.body, color: LIGHT_THEME.surface.foreground },
  days: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  day: {
    minHeight: MIN_TOUCH_TARGET_DP,
    minWidth: MIN_TOUCH_TARGET_DP,
    paddingHorizontal: SPACING.sm,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
  },
  daySelected: { borderColor: LIGHT_THEME.surface.foreground, borderWidth: 2 },
  dayLabel: { fontSize: FONT_SIZE.body, color: LIGHT_THEME.surface.foreground },
  choice: {
    gap: SPACING.xxs,
    minHeight: MIN_TOUCH_TARGET_DP,
    padding: SPACING.sm,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
  },
  choiceSelected: { borderColor: LIGHT_THEME.surface.foreground, borderWidth: 2 },
  choiceLabel: { fontSize: FONT_SIZE.body, color: LIGHT_THEME.surface.foreground },
  line: {
    gap: SPACING.xxs,
    paddingVertical: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: LIGHT_THEME.surface.border,
  },
  when: { fontSize: FONT_SIZE.caption, color: LIGHT_THEME.surfaceMuted.foreground },
});
