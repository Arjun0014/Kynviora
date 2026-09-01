/**
 * Safety screen.
 *
 * Spec references: `04` Phase 7.1 (assessment states and inbox; filters by profile, urgency and
 * status), `09` (product states; a coverage statement accompanies every result), `18` (never
 * present an absence of findings as reassurance), `23` D-005 (evidence level and urgency are never
 * combined) and D-014 (an absence of a matched rule must never render as approval), `11` and
 * DEC-010 (safety is server-authoritative), `BLK-006`, DEC-016.
 *
 * ONE LINE PER ITEM, NOT ONE PER ALERT
 * This screen used to list published alerts, which meant an item with no alert did not appear at
 * all - and a person reading it could not tell "checked, nothing matched" from "never checked".
 * `23` D-014 is about an absence rendering as approval, and an omission is the quietest way to do
 * it. Every item now has a line, and the line says which of the two it is.
 *
 * NOTHING IS PUBLISHABLE, AND THAT IS STILL THE DESIGN
 * `BLK-006` means no safety rule reaches a user without a qualified clinical or legal reviewer and
 * none exists; DEC-016 means every shipped regulatory fixture is deliberately rejected by the
 * Citation Gate. So every line here currently reads "not enough information", which is the honest
 * answer, and the coverage statement is on screen in every state - because "Kynviora found
 * nothing" and "there is nothing to find" are different sentences and only the first is true.
 *
 * THE LENS OPENS FROM AN ITEM, WHERE THE SUBSTANCE IS
 * `09` shows a regulatory status "beside, not substituted for" the safety state, so the Lens is
 * reached from a line rather than being its own destination. The control appears only where the
 * item has a substance whose mapping to a canonical concept is exact - absent rather than
 * disabled, because a Lens opened on a substance nobody confirmed is in the pack would answer
 * about whatever it was given. Until guided capture lands (`DEV-024`) that is every item, so the
 * control appears nowhere and says nothing false while it does.
 *
 * NO COUNT, NO BADGE, NO RANKING
 * The filters narrow; they do not rank. There is no "3 items need action" anywhere on this screen
 * and no code path in this app that could compute a severity: the rule engine is server-side
 * (DEC-010) and this screen renders what a reviewer approved.
 */

import { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  MIN_TOUCH_TARGET_DP,
  presentSafetyState,
} from '@kynviora/presentation';
import { PRODUCT_SAFETY_STATES, type ProductSafetyState } from '@kynviora/domain';
import {
  alertDetailScreenView,
  lensView,
  safetyInboxView,
  screenStateForFailure,
  type AlertDetailScreenView,
  type LensView,
  type SafetyInboxLineView,
} from '@kynviora/contracts';
import { useApi } from '@/api/ApiProvider';
import { useProfiles } from '@/api/ProfileProvider';
import { useResource } from '@/api/useResource';
import { Screen } from '@/components/Screen';
import { ResourceState } from '@/components/ScreenState';
import { PrimaryButton } from '@/components/PrimaryButton';
import { StatusChip } from '@/components/StatusChip';
import { RegulatoryLens } from '@/features/lens/RegulatoryLens';
import { AlertDetail } from '@/features/safety/AlertDetail';

const EMPTY = { lines: [], totalItems: 0 } as const;

export default function SafetyScreen() {
  const { client } = useApi();
  const { activeProfileId } = useProfiles();

  /**
   * The state filter, as a set the user toggles.
   *
   * Held here rather than sent as a default, so an unfiltered screen is the one a person lands on.
   * A safety screen that opened pre-filtered would hide items without saying it had.
   */
  const [states, setStates] = useState<readonly ProductSafetyState[]>([]);

  /**
   * The substance whose Lens is open, or `null`.
   *
   * The whole request, not just the key: `09` makes the answer depend on the disclosed
   * concentration and the use type, so asking about a substance without the context it was found
   * in would produce a different - and less applicable - answer than the item deserves.
   */
  const [lensFor, setLensFor] = useState<{
    readonly substanceKey: string;
    readonly disclosedConcentrationPercent: number | null;
  } | null>(null);

  /**
   * The alert whose detail is open, or `null`.
   *
   * `04` Phase 7.3 is reached from a line rather than being its own destination, for the same
   * reason the Lens is: an alert is about an item, and a detail screen with its own tab would be
   * a list of alerts again - which is what Phase 7.1 stopped this screen being.
   */
  const [alertFor, setAlertFor] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [reportMessage, setReportMessage] = useState<string | null>(null);

  const load = useMemo(
    () =>
      client === null || activeProfileId === null
        ? null
        : () => client.safetyInbox(activeProfileId, { states }),
    [client, activeProfileId, states],
  );

  const { resource, reload, refreshing } = useResource(load, {
    enabled: activeProfileId !== null,
    // Not empty when the shelf is empty - empty when this profile has no items at all. A filter
    // that matches nothing is a different screen from a profile with nothing on its shelf, and
    // the second is the only one the generic empty copy describes.
    isEmpty: (value) => value.totalItems === 0,
  });

  const view = useMemo(() => safetyInboxView(resource.value ?? EMPTY), [resource.value]);

  const loadLens = useMemo(
    () =>
      client === null || lensFor === null
        ? null
        : () =>
            client.regulatoryLens({
              substanceKey: lensFor.substanceKey,
              ...(lensFor.disclosedConcentrationPercent === null
                ? {}
                : { disclosedConcentrationPercent: lensFor.disclosedConcentrationPercent }),
            }),
    [client, lensFor],
  );

  const { resource: lensResource } = useResource(loadLens, { enabled: lensFor !== null });

  const lens: LensView | null = useMemo(
    () => (lensResource.value === null ? null : lensView(lensResource.value.lens)),
    [lensResource.value],
  );

  const loadAlert = useMemo(
    () => (client === null || alertFor === null ? null : () => client.alertDetail(alertFor)),
    [client, alertFor],
  );

  const { resource: alertResource, reload: reloadAlert } = useResource(loadAlert, {
    enabled: alertFor !== null,
  });

  const alertView: AlertDetailScreenView | null = useMemo(
    () => (alertResource.value === null ? null : alertDetailScreenView(alertResource.value)),
    [alertResource.value],
  );

  /**
   * Tell the server the match is wrong.
   *
   * The outcome union is destructured rather than caught: `06` requires every critical route to
   * define its offline and error states, and this one has to say plainly whether the report was
   * recorded. A silent failure here would leave somebody believing they had reported a wrong
   * alert about their own medicine.
   */
  const onReportIncorrect = useCallback(() => {
    if (client === null || alertFor === null) return;
    setReporting(true);
    setReportMessage(null);
    void client.reportIncorrectMatch(alertFor).then((outcome) => {
      setReporting(false);
      if (outcome.kind === 'OK') {
        setReportMessage(
          outcome.value.alreadyReported
            ? 'You had already told Kynviora this match is wrong.'
            : 'Recorded. Kynviora has kept this on the alert; the alert itself has not changed.',
        );
        reloadAlert();
        return;
      }
      setReportMessage(
        outcome.kind === 'OFFLINE'
          ? 'Kynviora could not reach the server, so nothing was recorded. Try again later.'
          : 'Kynviora could not record that. Nothing about the alert has changed.',
      );
      // The screen state the failure maps to, so an authorization loss is not reported as a
      // network problem.
      void screenStateForFailure(outcome);
    });
  }, [client, alertFor, reloadAlert]);

  const onRetry = useCallback(() => {
    reload();
  }, [reload]);

  if (alertFor !== null) {
    return (
      <Screen title="Safety" intro="What this alert rests on, and what Kynviora worked out.">
        <AlertDetail
          view={alertView}
          state={alertResource.state}
          onReportIncorrect={onReportIncorrect}
          reporting={reporting}
          reportMessage={reportMessage}
          onClose={() => {
            setAlertFor(null);
            setReportMessage(null);
          }}
        />
      </Screen>
    );
  }

  if (lensFor !== null) {
    return (
      <Screen title="Safety" intro="How supported jurisdictions treat this substance.">
        <RegulatoryLens
          substanceKey={lensFor.substanceKey}
          view={lens}
          state={lensResource.state}
          onClose={() => {
            setLensFor(null);
          }}
        />
      </Screen>
    );
  }

  return (
    <Screen
      title="Safety"
      intro="Every item on this shelf, and what Kynviora can say about it today."
      onRefresh={onRetry}
      refreshing={refreshing}
    >
      <ResourceState resource={resource} onRetry={onRetry} />

      {/* Filters, offered as the five states rather than as "show me the bad ones". Each is a
          toggle with its own label and accessibility state, never colour alone (`18`). */}
      <View style={styles.filters}>
        {PRODUCT_SAFETY_STATES.map((state) => {
          const chosen = states.includes(state);
          const presentation = presentSafetyState(state);
          return (
            <Pressable
              key={state}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: chosen }}
              accessibilityLabel={presentation.label}
              accessibilityHint={presentation.description}
              onPress={() => {
                setStates((current) =>
                  chosen ? current.filter((s) => s !== state) : [...current, state],
                );
              }}
              style={[
                styles.filter,
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
              <Text style={styles.filterLabel}>
                {chosen ? '☑  ' : '☐  '}
                {presentation.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Says the list is a subset without counting anything urgent. `02` refuses the badge; this
          is the size of the shelf, which is a fact about the shelf. */}
      {view.filtered ? (
        <Text style={styles.coverage}>
          Showing {view.lines.length} of {view.totalItems} items on this shelf.
        </Text>
      ) : null}

      {view.lines.map((line) => (
        <SafetyRow
          key={line.ownedItemId}
          line={line}
          onOpenLens={setLensFor}
          onOpenAlert={setAlertFor}
        />
      ))}

      {/* Rendered in every state, including the empty one. `09` requires the coverage statement
          to accompany the result rather than be inferred from its absence. */}
      <Text style={styles.coverage}>{view.coverageStatement}</Text>
    </Screen>
  );
}

function SafetyRow({
  line,
  onOpenLens,
  onOpenAlert,
}: {
  readonly line: SafetyInboxLineView;
  readonly onOpenLens: (substance: {
    readonly substanceKey: string;
    readonly disclosedConcentrationPercent: number | null;
  }) => void;
  readonly onOpenAlert: (alertPublicationId: string) => void;
}) {
  return (
    <View style={styles.alert}>
      <Text accessibilityRole="header" style={styles.name}>
        {line.displayName}
      </Text>

      {/* The state, and beside it - never merged with it - urgency and evidence. `23` D-005, and
          Phase 7.1's second exit criterion. A line with no live alert shows neither, because it
          has neither: a default chip would be a claim nobody made. */}
      <StatusChip presentation={line.state} showDescription />
      {line.urgency === null ? null : <StatusChip presentation={line.urgency} showDescription />}
      {line.evidence === null ? null : <StatusChip presentation={line.evidence} showDescription />}

      {/* When it was last looked at, or that it never has been. The absence is the point: an item
          Kynviora has never assessed must not read like one it checked this morning. */}
      <Text style={styles.coverage}>
        {line.lastAssessedAt === null
          ? 'Kynviora has not assessed this item.'
          : `Last assessed ${line.lastAssessedAt.slice(0, 10)}.`}
      </Text>

      {/* Only where there is a live alert to explain. A line whose state came from an assessment
          rather than a publication has nothing to open, and a disabled control would state that
          an explanation exists and is being withheld (DEC-045). */}
      {line.alertPublicationId === null ? null : (
        <PrimaryButton
          label="Why am I seeing this?"
          variant="secondary"
          onPress={() => {
            onOpenAlert(line.alertPublicationId as string);
          }}
        />
      )}

      {/* Beside the safety state, never substituted for it (`09`). One control per confirmed
          substance, and none at all where there are none - a Lens opened on a substance nobody
          confirmed is in the pack would answer about whatever it was given. */}
      {line.substances.map((substance) => (
        <PrimaryButton
          key={substance.substanceKey}
          label={`How ${substance.preferredName} is treated elsewhere`}
          variant="secondary"
          onPress={() => {
            onOpenLens({
              substanceKey: substance.substanceKey,
              disclosedConcentrationPercent: substance.disclosedConcentrationPercent,
            });
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  alert: {
    gap: SPACING.sm,
    padding: SPACING.md,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
    backgroundColor: LIGHT_THEME.surface.background,
  },
  name: {
    fontSize: FONT_SIZE.title,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs },
  filter: {
    minHeight: MIN_TOUCH_TARGET_DP,
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  filterLabel: {
    fontSize: FONT_SIZE.caption,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  coverage: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
});
