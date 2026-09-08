/**
 * The Coverage Center - the Safety screen, under a name that says what it answers.
 *
 * It was the third of five primary destinations until 2026-09-08. Under the approved V3 direction
 * it keeps every screen, every sentence and every rule and loses the tab (DEC-151): Safety is a
 * cross-cutting lens, reached from the Safety Lens on Shelf, from evidence inside item detail,
 * from a notice on Today, and - for the question this screen exists to answer, *what has Kynviora
 * actually checked and what has it not* - from a control on Shelf that asks it in those words.
 *
 * The heading changed with the address and the content did not. "Safety" named a place; "Coverage
 * Center" names the question, which is the one thing a person arriving here already has.
 *
 * Spec references: `04` Phase 7.1 (assessment states and inbox; filters by profile, urgency and
 * status), `09` (product states; a coverage statement accompanies every result), `18` (never
 * present an absence of findings as reassurance), `23` D-005 (evidence level and urgency are never
 * combined) and D-014 (an absence of a matched rule must never render as approval), `11` and
 * DEC-010 (safety is server-authoritative), `BLK-006`, DEC-016, DEC-130, DEC-138.
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
 * WHY THE COVERAGE STATEMENT IS THE FIRST THING AND NOT THE LAST (DEC-138)
 * It used to sit under the list. On a shelf of five identical "not enough information" lines the
 * conclusion is formed while scanning, so a qualification arriving underneath arrives after the
 * thing it was meant to qualify. And on a longer shelf it is below the fold, which for a sentence
 * whose whole job is to stop a misreading is the same as not being there. The design system's own
 * rule is that a limitation never moves down a layer, and below the fold is a layer. It is a card
 * in `informational`, at the same visual rank as the results - which is what `09` means by the
 * coverage statement accompanying the result rather than being inferred from its absence.
 *
 * THE LENS OPENS FROM AN ITEM, WHERE THE SUBSTANCE IS
 * `09` shows a regulatory status "beside, not substituted for" the safety state, so the Lens is
 * reached from a line rather than being its own destination. The control appears only where the
 * item has a substance whose mapping to a canonical concept is exact - absent rather than
 * disabled, because a Lens opened on a substance nobody confirmed is in the pack would answer
 * about whatever it was given. Until guided capture lands (`DEV-024`) that is every item, so the
 * control appears nowhere and says nothing false while it does.
 *
 * URGENCY AND EVIDENCE SIT IN THEIR OWN BLOCK, LABELLED AS TWO QUESTIONS
 * `23` D-005 forbids merging them, and three chips in a row is how they get merged anyway: a
 * person reads a strip of adjacent chips as one compound verdict. So where a line has them they
 * are drawn in a sunken well under their own marker, each behind its own question - "How soon"
 * and "How well established" - with a sentence saying neither answers the other. Where a line has
 * no live alert it has neither, and the block is absent rather than empty: a default chip would be
 * a claim nobody made.
 *
 * NO COUNT, NO BADGE, NO RANKING
 * The filters narrow; they do not rank. There is no "3 items need action" anywhere on this screen
 * and no code path in this app that could compute a severity: the rule engine is server-side
 * (DEC-010) and this screen renders what a reviewer approved. The one number it may state is the
 * size of the shelf, which is a fact about the shelf.
 *
 * THE CHOSEN FILTER CARRIES `selection`, NOT `informational`
 * It used to carry `informational`, which is the colour a fact about somebody's medicine is drawn
 * in. "This is the filter you turned on" and "here is something about your medicine" must not be
 * the same colour, or the second stops being noticeable (DEC-130). `selection` is the one hue in
 * this app that is about the interface rather than about a product.
 */

import { useCallback, useMemo, useState } from 'react';
import { View, StyleSheet, Pressable } from 'react-native';
import {
  RADIUS,
  SPACING,
  MIN_TOUCH_TARGET_DP,
  presentSafetyState,
  type Theme,
} from '@kynviora/presentation';
import { PRODUCT_SAFETY_STATES, type ProductSafetyState } from '@kynviora/domain';
import {
  alertDetailScreenView,
  lensView,
  safetyInboxView,
  safetyReceiptScreenView,
  screenStateForFailure,
  type AlertDetailScreenView,
  type LensView,
  type SafetyInboxLineView,
  type SafetyReceiptScreenView,
} from '@kynviora/contracts';
import { useApi } from '@/api/ApiProvider';
import { useProfiles } from '@/api/ProfileProvider';
import { useResource } from '@/api/useResource';
import { Card } from '@/components/Card';
import { Screen } from '@/components/Screen';
import { SectionHeader } from '@/components/SectionHeader';
import { ResourceState } from '@/components/ScreenState';
import { PrimaryButton } from '@/components/PrimaryButton';
import { StatusChip } from '@/components/StatusChip';
import { Typography } from '@/components/Typography';
import { RegulatoryLens } from '@/features/lens/RegulatoryLens';
import { AlertDetail } from '@/features/safety/AlertDetail';
import { SafetyReceipt } from '@/features/safety/SafetyReceipt';
import { useThemedStyles } from '@/theme/ThemeProvider';
import { TalkBar } from '@/voice/TalkBar';
import { haptic } from '@/platform/haptics';

const EMPTY = { lines: [], totalItems: 0 } as const;

/**
 * The marker over the coverage card.
 *
 * Deliberately not "Safety summary" or anything else that could be read as a verdict about the
 * shelf. It names what Kynviora is doing, which is watching sources - and the sentence under it
 * says what that currently amounts to.
 */
const COVERAGE_HEADING = 'What Kynviora is watching';

export default function SafetyScreen() {
  const styles = useThemedStyles(makeStyles);
  const { client } = useApi();
  const { activeProfile, activeProfileId } = useProfiles();

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

  /**
   * The alert whose receipt is open, or `null`.
   *
   * Opened from the detail rather than from the inbox, and held separately from `alertFor` so
   * closing the receipt returns to the alert it is about rather than to the list. A receipt read
   * without the alert beside it is a resolution with nothing to resolve.
   */
  const [receiptFor, setReceiptFor] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordMessage, setRecordMessage] = useState<string | null>(null);

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

  const loadReceipt = useMemo(
    () => (client === null || receiptFor === null ? null : () => client.safetyReceipt(receiptFor)),
    [client, receiptFor],
  );

  const { resource: receiptResource, reload: reloadReceipt } = useResource(loadReceipt, {
    enabled: receiptFor !== null,
  });

  const receiptView: SafetyReceiptScreenView | null = useMemo(
    () => (receiptResource.value === null ? null : safetyReceiptScreenView(receiptResource.value)),
    [receiptResource.value],
  );

  /**
   * Record what the person did.
   *
   * The outcome union is destructured for the same reason report-incorrect's is: somebody
   * believing they recorded that a pack was thrown away when nothing was written is the failure
   * this screen exists to prevent. Success reloads the receipt rather than patching state
   * locally, because what stands after a write is the server's answer (DEC-075) and a client that
   * guessed it would show a history the log does not have.
   */
  const onRecordResolution = useCallback(
    (resolution: string) => {
      if (client === null || receiptFor === null) return;
      setRecording(true);
      setRecordMessage(null);
      void client.recordResolution(receiptFor, { resolution }).then((outcome) => {
        setRecording(false);
        if (outcome.kind === 'OK') {
          // Beside the sentence, never instead of it (DEC-131). Every branch below writes a
          // sentence into a polite live region first; the haptic is the second channel.
          haptic('confirm');
          setRecordMessage(
            outcome.value.alreadyRecorded
              ? 'That was already what stood, so nothing changed.'
              : outcome.value.replaced
                ? 'Recorded. It replaced what you had recorded before, which is still listed above.'
                : 'Recorded. The alert and what Kynviora assessed have not changed.',
          );
          reloadReceipt();
          return;
        }
        haptic('failure');
        setRecordMessage(
          outcome.kind === 'OFFLINE'
            ? 'Kynviora could not reach the server, so nothing was recorded. Try again later.'
            : 'Kynviora could not record that. Nothing has changed.',
        );
        void screenStateForFailure(outcome);
      });
    },
    [client, receiptFor, reloadReceipt],
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
        haptic('confirm');
        setReportMessage(
          outcome.value.alreadyReported
            ? 'You had already told Kynviora this match is wrong.'
            : 'Recorded. Kynviora has kept this on the alert; the alert itself has not changed.',
        );
        reloadAlert();
        return;
      }
      haptic('failure');
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

  if (receiptFor !== null) {
    return (
      <Screen title="Coverage Center" intro="What you recorded, and what Kynviora cannot settle.">
        <SafetyReceipt
          view={receiptView}
          state={receiptResource.state}
          onRecord={onRecordResolution}
          recording={recording}
          recordMessage={recordMessage}
          onClose={() => {
            setReceiptFor(null);
            setRecordMessage(null);
            // The detail carries a "reported incorrect" state the receipt can change, so it is
            // re-read rather than left as it was when the receipt opened.
            reloadAlert();
          }}
        />
      </Screen>
    );
  }

  if (alertFor !== null) {
    return (
      <Screen
        title="Coverage Center"
        intro="What this alert rests on, and what Kynviora worked out."
      >
        <AlertDetail
          view={alertView}
          state={alertResource.state}
          onReportIncorrect={onReportIncorrect}
          reporting={reporting}
          reportMessage={reportMessage}
          onOpenReceipt={() => {
            setReceiptFor(alertFor);
          }}
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
      <Screen title="Coverage Center" intro="How supported jurisdictions treat this substance.">
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

  // A filter is on and matched nothing. Distinct from an empty shelf, which `isEmpty` above hands
  // to `ResourceState` with its own copy - and the two must not share a sentence, because one is
  // about the filter and the other is about the household.
  const filteredToNothing = view.totalItems > 0 && view.lines.length === 0;

  return (
    <Screen
      title="Coverage Center"
      eyebrow={activeProfile?.displayName ?? null}
      intro="Every item on this shelf, and what Kynviora can say about it today."
      onRefresh={onRetry}
      refreshing={refreshing}
      footer={<TalkBar />}
    >
      <ResourceState resource={resource} onRetry={onRetry} />

      {/* The coverage statement, first and at the same rank as the results (DEC-138). Drawn in
          every state including the filtered and empty ones: `09` requires it to accompany the
          result rather than be inferred from its absence, and a filtered page with no rows on it
          is the easiest place in the app to read "nothing found" as "nothing to find". */}
      <Card tone="informational">
        <Typography role="overline" colour="informational" heading>
          {COVERAGE_HEADING}
        </Typography>
        <Typography role="bodyLarge" colour="informational">
          {view.coverageStatement}
        </Typography>
      </Card>

      <View style={styles.block}>
        <SectionHeader
          title="Narrow this list"
          explanation="A filter changes which items are shown. It never changes their order."
        />

        {/* Filters, offered as the five states rather than as "show me the bad ones". Each is a
            checkbox with its own name and its own announced state - the tick is drawn in the
            label as well, because `18` forbids meaning carried by colour alone. */}
        <View style={styles.filters}>
          {PRODUCT_SAFETY_STATES.map((state) => {
            const chosen = states.includes(state);
            const presentation = presentSafetyState(state);
            return (
              <Pressable
                key={state}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: chosen }}
                // The bare label, and deliberately not "…filter, on": the state belongs in
                // `accessibilityState`, which is where a screen reader looks for it, and a name
                // that changed with the state would be a control that renames itself when pressed.
                accessibilityLabel={presentation.label}
                accessibilityHint={presentation.description}
                onPress={() => {
                  haptic('selection');
                  setStates((current) =>
                    chosen ? current.filter((s) => s !== state) : [...current, state],
                  );
                }}
                style={[styles.filter, chosen ? styles.filterOn : null]}
              >
                {/* The tick is in the text as well as in the styling, because `18` forbids
                    meaning carried by colour alone. `Typography` rather than a raw `Text` so the
                    label grows with the system font scale like every other control's does. */}
                <Typography role="label" {...(chosen ? { style: styles.filterLabelOn } : {})}>
                  {chosen ? '☑  ' : '☐  '}
                  {presentation.label}
                </Typography>
              </Pressable>
            );
          })}
        </View>

        {/* Says the list is a subset without counting anything urgent. `02` refuses the badge;
            this is the size of the shelf, which is a fact about the shelf. */}
        {view.filtered ? (
          <Typography role="caption" colour="secondary">
            Showing {view.lines.length} of {view.totalItems} items on this shelf.
          </Typography>
        ) : null}
      </View>

      {view.totalItems === 0 ? null : (
        <SectionHeader
          title="Every item on this shelf"
          explanation="Each item has a line, whether or not Kynviora has anything to say about it."
        />
      )}

      {filteredToNothing ? (
        <Card>
          <Typography role="body" colour="secondary">
            Nothing on this shelf is in the state you asked for. That is a fact about the filter,
            not about the items.
          </Typography>
        </Card>
      ) : null}

      {view.lines.map((line) => (
        <SafetyRow
          key={line.ownedItemId}
          line={line}
          onOpenLens={setLensFor}
          onOpenAlert={setAlertFor}
        />
      ))}
    </Screen>
  );
}

/**
 * One item's line.
 *
 * Exported so it can be rendered on its own. What it decides is which of `23`'s two hardest rules
 * a line is currently expressing - an absence that must not read as approval, and two dimensions
 * that must not merge - and reaching it through the whole screen would mean standing up four
 * providers and a network client to ask a question about a conditional.
 */
export function SafetyRow({
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
  const styles = useThemedStyles(makeStyles);
  // Null together by construction (`safetyInboxView`), and read as a pair here so the block is
  // absent rather than half-drawn if that ever stops being true.
  const hasAlertDimensions = line.urgency !== null || line.evidence !== null;

  return (
    <Card>
      <Typography role="title" heading>
        {line.displayName}
      </Typography>

      {/* The state, with its qualification attached rather than as a bare label. `18`: a
          limitation travels with the fact it qualifies, at every level. */}
      <StatusChip presentation={line.state} showDescription />

      {/* When it was last looked at, or that it never has been. The absence is the point: an item
          Kynviora has never assessed must not read like one it checked this morning, and a blank
          where the date goes reads exactly like that. In a sunken well, which is the design
          system saying "this is about the record" - deliberately not a tone, because a coloured
          panel here would be a colour claiming something about the medicine. */}
      <View style={styles.record}>
        <Typography role="caption" colour="secondary">
          {line.lastAssessedAt === null
            ? 'Kynviora has not assessed this item.'
            : `Last assessed ${line.lastAssessedAt.slice(0, 10)}.`}
        </Typography>
      </View>

      {/* Two dimensions, two questions, one sentence saying they are not the same question.
          `23` D-005. Absent where there is no live alert, because then there is neither - and a
          default chip would be a claim nobody made. */}
      {hasAlertDimensions ? (
        <View style={styles.dimensions}>
          <Typography role="overline" colour="secondary" heading>
            About this alert
          </Typography>

          {line.urgency === null ? null : (
            <View style={styles.dimension}>
              <Typography role="label" colour="secondary">
                How soon
              </Typography>
              <StatusChip presentation={line.urgency} showDescription />
            </View>
          )}

          {line.evidence === null ? null : (
            <View style={styles.dimension}>
              <Typography role="label" colour="secondary">
                How well established
              </Typography>
              <StatusChip presentation={line.evidence} showDescription />
            </View>
          )}

          <Typography role="caption" colour="secondary">
            These are two separate things. Neither one answers the other.
          </Typography>
        </View>
      ) : null}

      {/* Only where there is a live alert to explain. A line whose state came from an assessment
          rather than a publication has nothing to open, and a disabled control would state that
          an explanation exists and is being withheld (DEC-045). */}
      {line.alertPublicationId === null && line.substances.length === 0 ? null : (
        <View style={styles.actions}>
          {line.alertPublicationId === null ? null : (
            <PrimaryButton
              label="Why am I seeing this?"
              onPress={() => {
                onOpenAlert(line.alertPublicationId as string);
              }}
            />
          )}

          {/* Beside the safety state, never substituted for it (`09`). One control per confirmed
              substance, and none at all where there are none - a Lens opened on a substance
              nobody confirmed is in the pack would answer about whatever it was given. */}
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
      )}
    </Card>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    // A block of one idea - the filters and what they did - so it sits together and the list
    // below it is clearly something else.
    block: { gap: SPACING.sm },
    filters: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs },
    filter: {
      minHeight: MIN_TOUCH_TARGET_DP,
      justifyContent: 'center',
      paddingHorizontal: SPACING.lg,
      borderWidth: 1,
      borderRadius: RADIUS.pill,
      borderColor: theme.line.strong,
      backgroundColor: theme.surface.background,
    },
    filterOn: {
      borderColor: theme.selection.border,
      backgroundColor: theme.selection.background,
    },
    // `selection` is a pair rather than one of the seven semantic tones, so it is not something
    // `Typography` will take by name - a status must not be able to resolve to an interface
    // colour. Named here, where the chip's own background is being named beside it.
    filterLabelOn: { color: theme.selection.foreground },
    // The sunken well: "this is about the record", and the same treatment a read-only block gets
    // everywhere else in this app.
    record: {
      padding: SPACING.md,
      borderRadius: RADIUS.md,
      backgroundColor: theme.sunken.background,
    },
    dimensions: {
      gap: SPACING.sm,
      padding: SPACING.md,
      borderRadius: RADIUS.md,
      backgroundColor: theme.sunken.background,
    },
    dimension: { gap: SPACING.xs },
    actions: { gap: SPACING.sm, marginTop: SPACING.xs },
  });
