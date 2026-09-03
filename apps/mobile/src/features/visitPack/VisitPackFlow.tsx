/**
 * Preparing a Visit Pack.
 *
 * Spec references: `04` Phase 8.4, `06` Journey 8, `14` (step-up for exports), `16` (sharing is
 * deliberate and scoped), `18` (state the limitation; do not moralise about a decision the person
 * has already made), DEC-022, DEC-023.
 *
 * THREE STEPS, AND THE MIDDLE ONE IS THE POINT
 * Choose, review, then the pack. The review step is not a confirmation dialog: it is the thing the
 * digest is a promise about. What the screen displays at that moment is hashed and quoted with the
 * request, and the server refuses if rebuilding the selection from live records produces anything
 * else. So the candidates are fetched **once** and everything downstream works from that list -
 * re-fetching before hashing would quote a digest of content the user never saw and would silently
 * disarm the refusal that makes the promise real.
 *
 * WHAT A CHANGE MID-FLOW LOOKS LIKE
 * `EXPORT_CONTENT_CHANGED` is the one refusal here that is not a mistake: a record genuinely moved
 * between review and generation. The response is to reload and show the new list, not to retry -
 * retrying would send the same stale digest again, and a user pressing "try again" three times
 * deserves better than three identical refusals.
 */

import { useCallback, useMemo, useState } from 'react';
import { View, Text, TextInput, StyleSheet, Pressable } from 'react-native';
import * as Crypto from 'expo-crypto';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  MIN_TOUCH_TARGET_DP,
  VISIT_PACK_COPY,
  describeSection,
  type ScreenState as ScreenStateKind,
} from '@kynviora/presentation';
import type { VisitPackSection } from '@kynviora/domain';
import {
  buildVisitPack,
  contentChanged,
  screenStateForFailure,
  type DigestFn,
  type VisitPackCandidate,
} from '@kynviora/contracts';
import { useApi } from '@/api/ApiProvider';
import { useProfiles } from '@/api/ProfileProvider';
import { useResource } from '@/api/useResource';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import { VisitPackReview, type ReviewEntry } from './VisitPackReview';
import { newIdempotencyKey } from '@/platform/ids';

/**
 * SHA-256, from the platform.
 *
 * The canonical form is the domain's and is shared verbatim with the server; only the hashing is
 * a port, because it is asynchronous everywhere and comes from a different module on each
 * platform.
 */
const digest: DigestFn = (canonical) =>
  Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, canonical);

type Step = 'CHOOSE' | 'REVIEW' | 'DONE';

export function VisitPackFlow({ onClose }: { readonly onClose: () => void }) {
  const { client, elevate } = useApi();
  const { activeProfileId } = useProfiles();

  const [step, setStep] = useState<Step>('CHOOSE');
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [note, setNote] = useState('');
  const [sendState, setSendState] = useState<ScreenStateKind | null>(null);
  const [sendMessage, setSendMessage] = useState<string | null>(null);
  const [changedSinceReview, setChangedSinceReview] = useState(false);

  const load = useMemo(
    () =>
      client === null || activeProfileId === null
        ? null
        : () => client.visitPackCandidates(activeProfileId),
    [client, activeProfileId],
  );

  const { resource, reload } = useResource(load, {
    enabled: activeProfileId !== null,
    isEmpty: (value) => value.candidates.length === 0,
  });

  const candidates = resource.value?.candidates ?? [];

  const selectedEntries = useMemo<readonly ReviewEntry[]>(
    () =>
      candidates
        .filter((candidate) => selectedIds.includes(candidate.entityId))
        .map((candidate) => ({
          entityId: candidate.entityId,
          section: candidate.section as VisitPackSection,
          lines: candidate.lines,
          caveat: candidate.caveat ?? '',
        })),
    [candidates, selectedIds],
  );

  const onConfirm = useCallback(() => {
    const value = resource.value;
    if (client === null || activeProfileId === null || value === null) return;

    const elevated = elevate();
    if (elevated === null) {
      setSendState('STEP_UP_REQUIRED');
      return;
    }

    setSendState('LOADING');
    setSendMessage(null);

    void buildVisitPack(
      {
        profileId: activeProfileId,
        // Exactly what the review step displayed. Not re-fetched.
        candidates: value.candidates,
        selectedEntityIds: selectedIds,
        notes: note.trim() === '' ? [] : [note.trim()],
        // The server time of the response the user reviewed: "the content as of this moment is
        // what I looked at", which is the claim the digest backs up.
        reviewedAt: value.serverTime,
      },
      digest,
    ).then(
      (draft) => {
        if (!draft.ok) {
          setSendState('RECOVERABLE_ERROR');
          setSendMessage(draft.refusal.message);
          return;
        }

        void elevated.createVisitPack(draft.body, newIdempotencyKey()).then(
          (outcome) => {
            if (outcome.kind === 'OK') {
              setSendState(null);
              setStep('DONE');
              return;
            }
            if (contentChanged(outcome)) {
              // Not a mistake and not worth a retry: the records moved. Reload and send the user
              // back to the list, because the thing they reviewed no longer exists to be shared.
              setSendState(null);
              setChangedSinceReview(true);
              setStep('CHOOSE');
              setSelectedIds([]);
              reload();
              return;
            }
            setSendState(screenStateForFailure(outcome));
            setSendMessage(outcome.kind === 'REFUSED' ? outcome.message : null);
          },
          () => {
            setSendState('RECOVERABLE_ERROR');
            setSendMessage(null);
          },
        );
      },
      () => {
        setSendState('RECOVERABLE_ERROR');
        setSendMessage(null);
      },
    );
  }, [client, elevate, activeProfileId, resource.value, selectedIds, note, reload]);

  if (step === 'DONE') {
    return (
      <View style={styles.container}>
        <Text accessibilityRole="header" style={styles.heading}>
          {VISIT_PACK_COPY.createdHeading}
        </Text>
        <Text style={styles.body}>{VISIT_PACK_COPY.generatedNote}</Text>
        {/* Said at the end as well as the start. The one thing a person must not wonder about
            afterwards is whether Kynviora sent anything on its own. */}
        <Text style={styles.body}>{VISIT_PACK_COPY.notAutomatic}</Text>
        <PrimaryButton label="Done" onPress={onClose} />
      </View>
    );
  }

  if (step === 'REVIEW') {
    return (
      <VisitPackReview
        state={sendState ?? 'READY'}
        selected={selectedEntries}
        changedSinceReview={false}
        onConfirm={onConfirm}
        onBack={() => {
          setSendState(null);
          setSendMessage(null);
          setStep('CHOOSE');
        }}
        onRetry={() => {
          setSendState(null);
          setSendMessage(null);
        }}
      />
    );
  }

  if (resource.state !== 'READY' && resource.state !== 'EMPTY') {
    return <ScreenState state={resource.state} message={resource.message} onRetry={reload} />;
  }

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        {VISIT_PACK_COPY.chooseHeading}
      </Text>
      {/* Said before the list. Nothing is included until it is chosen, and someone scanning a
          screen of tick boxes should not have to infer that from their state. */}
      <Text style={styles.body}>{VISIT_PACK_COPY.chooseIntro}</Text>

      {changedSinceReview ? (
        <Text accessibilityLiveRegion="polite" style={styles.warning}>
          {VISIT_PACK_COPY.changedSinceReview}
        </Text>
      ) : null}

      {sendState !== null ? <ScreenState state={sendState} message={sendMessage} /> : null}

      {candidates.map((candidate) => (
        <CandidateRow
          key={candidate.entityId}
          candidate={candidate}
          chosen={selectedIds.includes(candidate.entityId)}
          onToggle={() => {
            setChangedSinceReview(false);
            setSelectedIds((current) =>
              current.includes(candidate.entityId)
                ? current.filter((id) => id !== candidate.entityId)
                : [...current, candidate.entityId],
            );
          }}
        />
      ))}

      <Text style={styles.label}>Anything you want to ask</Text>
      <Text style={styles.help}>
        Written in your own words. It is marked as yours, so whoever reads it knows Kynviora did not
        check it.
      </Text>
      <TextInput
        accessibilityLabel="Anything you want to ask"
        value={note}
        onChangeText={setNote}
        multiline
        style={styles.input}
      />

      <PrimaryButton
        label="Check what you are sharing"
        disabled={selectedIds.length === 0 && note.trim() === ''}
        onPress={() => {
          setStep('REVIEW');
        }}
      />
      <PrimaryButton label="Cancel" variant="secondary" onPress={onClose} />
    </View>
  );
}

function CandidateRow({
  candidate,
  chosen,
  onToggle,
}: {
  readonly candidate: VisitPackCandidate;
  readonly chosen: boolean;
  readonly onToggle: () => void;
}) {
  const section = describeSection(candidate.section as VisitPackSection);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: chosen }}
      accessibilityLabel={`${section.label}. ${candidate.lines.join('. ')}`}
      accessibilityHint={candidate.caveat ?? undefined}
      onPress={onToggle}
      style={[
        styles.candidate,
        {
          backgroundColor: chosen
            ? LIGHT_THEME.informational.background
            : LIGHT_THEME.surface.background,
          borderColor: chosen ? LIGHT_THEME.informational.border : LIGHT_THEME.surface.border,
        },
      ]}
    >
      <Text style={styles.sectionLabel}>
        {chosen ? '☑  ' : '☐  '}
        {section.label}
      </Text>
      {candidate.lines.map((line) => (
        <Text key={line} style={styles.body}>
          {line}
        </Text>
      ))}
      {/* The caveat travels with the entry into the pack, so it is shown here too - a person
          deciding what to share should see what a reader will be told about it. */}
      {candidate.caveat === null ? null : <Text style={styles.help}>{candidate.caveat}</Text>}
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
  body: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.normal,
    color: LIGHT_THEME.surface.foreground,
  },
  label: {
    fontSize: FONT_SIZE.body,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  help: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
  warning: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.normal,
    color: LIGHT_THEME.attention.foreground,
  },
  candidate: {
    minHeight: MIN_TOUCH_TARGET_DP,
    gap: SPACING.xxs,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  sectionLabel: {
    fontSize: FONT_SIZE.body,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  input: {
    minHeight: MIN_TOUCH_TARGET_DP * 2,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    fontSize: FONT_SIZE.body,
    color: LIGHT_THEME.surface.foreground,
    textAlignVertical: 'top',
  },
});
