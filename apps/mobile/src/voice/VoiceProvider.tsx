/**
 * Voice Mode, held together: the session, the gates, the executor and the bridge.
 *
 * Spec references: `17`, `13`, `14`, `12`, `18`, `06`. DEC-132 to DEC-136, `BLK-012`.
 *
 * WHAT THIS OWNS AND WHAT IT DOES NOT
 * It owns the conversation - the state machine, the transcript, the armed proposal - and the wire
 * from a heard sentence to a dispatched call. It owns **no policy**: which tools exist, what each
 * requires and what may be spoken are all in `@kynviora/agent`, which knows nothing about React
 * and is tested without one.
 *
 * WHERE THE CAPABILITIES COME FROM
 * The server, asked directly: `client.profileCapabilities` reports what this caller holds on the
 * active profile with the predicate the policies themselves apply (DEC-141). That does not
 * authorise anything - the route decides, every time, on the session (`11`, `13`) - it stops the
 * agent offering something the write would refuse, which is what `mayRecordDoses` already does on
 * the shelf (DEC-116).
 *
 * It used to be assembled from whatever screens somebody had happened to open, because there was
 * no route to ask. A caregiver who had not visited an item detail was therefore told to use the
 * screen for a change they were entirely entitled to make (`DEV-074`), which is Voice Mode
 * offering less than touch for no reason anybody had decided.
 *
 * WITH NO PROVIDER, THIS IS STILL A USABLE INTERFACE
 * There is no recogniser, no model and no voice (`BLK-012`), so nothing here listens or speaks.
 * What remains is a transcript, a set of very large buttons and the same six gates - which is a
 * simplified, high-contrast way to drive the app that an older adult can use today, and the shell
 * a provider drops into unchanged.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  checkCall,
  describeScreenContext,
  dispatch,
  emptySession,
  gateSpeech,
  isUtteranceKey,
  reduce,
  summariseProposal,
  utteranceForRefusal,
  UTTERANCES,
  screenPhrasings,
  voiceCallableTools,
  type DispatchContext,
  type PendingProposal,
  type SpeechPart,
  type ToolCall,
  type ToolCapability,
  type VoiceProviders,
  type VoiceSession,
} from '@kynviora/agent';
import type { DoseEventBody, ScheduleBody, ScheduleChangeBody } from '@kynviora/contracts';
import { useApi } from '@/api/ApiProvider';
import { useProfiles } from '@/api/ProfileProvider';
import { useResource } from '@/api/useResource';
import { usePendingSync } from '@/sync/PendingSyncProvider';
import {
  createToolExecutor,
  type QueuedWrites,
  type ToolResult,
  type VoiceBridge,
} from './executor';
import { resolveVoiceProviders } from './devScript';
import { capabilitiesFor } from './capabilities';
import { newIdempotencyKey } from '@/platform/ids';
import { useScreenContext } from './ScreenContextProvider';

export interface VoiceContextValue {
  readonly session: VoiceSession;
  /**
   * Whether Voice Mode is on screen.
   *
   * A flag rather than a route, for the reason every sheet in this app is: `06` fixes five
   * destinations and Voice Mode is an action available from all of them, not a sixth. Held in the
   * provider so the conversation survives being closed and reopened - somebody who put the phone
   * down mid-sentence comes back to what was said.
   */
  readonly isOpen: boolean;
  readonly open: () => void;
  /** Say something, as though it had been heard. The only way in. */
  readonly say: (text: string) => void;
  /** Confirm the armed proposal. Takes its id, so a stale yes cannot land on a new one. */
  readonly confirm: (proposalId: string) => void;
  readonly cancel: () => void;
  readonly close: () => void;
  /** Whether a provider is wired. `false` in this build, everywhere (`BLK-012`). */
  readonly canListen: boolean;
  readonly canSpeak: boolean;

  // -------------------------------------------------------------------------
  // The screen the bar is sitting on (DEC-157)
  // -------------------------------------------------------------------------

  /**
   * The sentences this screen offers, in its own order.
   *
   * What the panel shows instead of a chat history. A screen that declares nothing offers
   * nothing, and the panel says so - an honest empty state, not a bug.
   */
  readonly phrasings: readonly string[];
  /**
   * The context snapshot, rendered.
   *
   * Shown in the panel footer, and it is the **whole** of what a request would carry: route,
   * profile, what is focused, how many things are selected, how many actions were offered. No
   * medicine name, no lab value, no field one could arrive in (DEC-132).
   */
  readonly contextSummary: string;
  /**
   * Ask the screen to do one of the things it offered.
   *
   * The only way the agent reaches the interface, and it goes through the same shape as a tool
   * call one level down: a closed set declared by the side that can perform the work, resolved as
   * an own property, refused when it was never offered.
   */
  readonly runScreenAction: (actionId: string) => void;
}

const VoiceContext = createContext<VoiceContextValue | null>(null);

export interface VoiceProviderProps {
  readonly children: ReactNode;
  /** Injected by tests and by a future provider adapter. */
  readonly providers?: VoiceProviders;
  /** Where the app goes when a tool says to. Absent in tests, which assert on the session. */
  readonly bridge?: VoiceBridge;
  /**
   * Capabilities, where a caller has assembled them. Absent means derive from the active profile.
   *
   * Injected by tests, which are asserting what the gates do with a given set rather than how the
   * set is arrived at.
   */
  readonly capabilities?: ReadonlySet<ToolCapability>;
  /** Whether the caller owns the active profile. Absent means read it from the profile list. */
  readonly isOwner?: boolean;
  readonly online?: boolean;
  /** The clock, injected so a confirmation window is not measured against a device somebody moved. */
  readonly now?: () => number;
}

const NO_BRIDGE: VoiceBridge = {
  openScreen: () => undefined,
  openItem: () => undefined,
  openCamera: () => undefined,
  captureNextPhoto: () => undefined,
};

export function VoiceProvider({
  children,
  providers,
  bridge = NO_BRIDGE,
  capabilities,
  isOwner,
  online = true,
  now = () => Date.now(),
}: VoiceProviderProps) {
  const { client } = useApi();
  const { activeProfile, activeProfileId } = useProfiles();
  const screen = useScreenContext();
  // The server's own answer. `false` where the profile list has not arrived, which is the safe
  // direction: an agent offered nothing is a person told to use the screen, and the screen works.
  const owns = isOwner ?? activeProfile?.isOwner ?? false;
  // Nothing, unless a development build asked for the scripted agent (`DEV-073`). `NO_PROVIDERS`
  // is what an ordinary run gets, and it is what ships.
  const resolvedProviders = useMemo(
    () =>
      providers ??
      resolveVoiceProviders(
        {
          EXPO_PUBLIC_DEV_VOICE_SCRIPT: process.env.EXPO_PUBLIC_DEV_VOICE_SCRIPT,
          EXPO_PUBLIC_DEV_VOICE_ITEM_ID: process.env.EXPO_PUBLIC_DEV_VOICE_ITEM_ID,
        },
        activeProfileId,
      ),
    [providers, activeProfileId],
  );
  const [session, setSession] = useState<VoiceSession>(() => emptySession(activeProfileId));
  const [isOpen, setIsOpen] = useState(false);
  // Ids only have to be unique within a conversation, and they are never stored or sent.
  const counter = useRef(0);
  const nextId = useCallback(() => {
    counter.current += 1;
    return `voice-${String(counter.current)}`;
  }, []);

  /**
   * What the server says this caller may do on the active profile.
   *
   * Read here rather than on a screen, for the reason `PendingSenders` is not on a screen either:
   * what an interface may offer must not depend on which tab somebody last opened. `null` until it
   * arrives, and `capabilitiesFor` narrows an absent answer to the read-only set - the safe
   * direction, because an agent offered nothing is a person told to use the screen and the screen
   * works.
   *
   * Not fetched for an owner: `capabilitiesFor` short-circuits on ownership, so the request would
   * be a round trip whose answer changes nothing. Not fetched with Voice Mode closed either - a
   * conversation nobody has opened needs no capabilities - which keeps this off every cold start.
   */
  const loadCapabilities = useMemo(
    () =>
      client === null || activeProfileId === null || owns || !isOpen
        ? null
        : async () => {
            const outcome = await client.profileCapabilities(activeProfileId);
            // The profile the answer is **about**, carried with it. See `granted` below.
            return outcome.kind === 'OK'
              ? { ...outcome, value: { ...outcome.value, profileId: activeProfileId } }
              : outcome;
          },
    [client, activeProfileId, owns, isOpen],
  );

  const { resource: capabilityResource } = useResource(loadCapabilities, {
    enabled: loadCapabilities !== null,
  });

  /**
   * What the server said, **only if it said it about the profile being looked at now**.
   *
   * `useResource` keeps the last successful value when a later read fails - deliberately, because
   * `18` would rather show content labelled stale than take it away. That is right for a medicine
   * list and wrong for an authorization report: switching person with no signal would leave one
   * profile's grant applied to another, and a caregiver holding `MANAGE_MEDICINES` on their mother
   * would be offered it on their father until the next successful read.
   *
   * So the answer carries the profile it was asked about, and a mismatch reads as no answer -
   * which narrows to the empty set, which is a person told to use the screen. `13`'s rule that a
   * profile ID narrows rather than grants, applied to the report as well as to the request.
   */
  const granted =
    capabilityResource.value !== null && capabilityResource.value.profileId === activeProfileId
      ? capabilityResource.value.capabilities
      : null;

  const context = useMemo<DispatchContext>(
    () => ({
      // What the server reported, never a guess (`DEV-074`, DEC-141). This authorises nothing:
      // the route checks again, on the session, every time.
      capabilities:
        capabilities ??
        capabilitiesFor({ isOwner: owns, ...(granted === null ? {} : { granted }) }),
      isOwner: owns,
      // Always false. Nothing in this build can re-authenticate by voice, and every tool that
      // needs it is `TOUCH_ONLY` anyway - so this is the second of two mechanisms rather than the
      // only one (`14`).
      stepUpFresh: false,
      online,
      origin: 'VOICE',
      confirmed: false,
    }),
    [capabilities, owns, granted, online],
  );

  /**
   * Keep a write the server could not be told about, in the app's own journal (DEC-140, DEC-148).
   *
   * THE SAME PATH AS TOUCH, NOT A SECOND ONE
   * `usePendingSync().queue` is the identical call the dose sheet and the schedule sheet make,
   * under the identical entity types, the identical keys and the identical preconditions - so the
   * drain, the per-entity policy (`13`), the retry budget and `PendingSenders`' wire call are all
   * the ones already exercised by `OFF-1` to `OFF-7` on hardware. Voice adds no sync mechanism; it
   * reaches the one that exists. That is DEC-132 applied to the offline path - the agent's reach is
   * the app's reach because it is the app's code doing the reaching.
   *
   * `queue` answers `false` where `13`'s policy refuses the type or the store could not take the
   * write, and the executor says the honest sentence for that rather than the queued one.
   *
   * Each of the three is written out rather than folded into one generic call, because each
   * carries a different one of `13`'s guarantees and the differences are the point: a dose and a
   * schedule create keep the key the attempt spent, and a schedule change keeps the version it was
   * made against instead. A single call taking all three would have to decide which applies, which
   * is the decision the entity type already makes.
   */
  const { queue, list: listPending } = usePendingSync();
  const queued = useMemo<QueuedWrites>(
    () => ({
      dose: (body: DoseEventBody, key: string): Promise<boolean> =>
        queue({
          entityType: 'dose_event',
          entityId: body.ownedItemId,
          mutation: 'CREATE',
          payload: body,
          baseVersion: null,
          // The key the failed attempt already spent. `OFFLINE` is inferred from a failed fetch,
          // which is also what a request that arrived and lost its answer looks like - and `13`
          // resolves this table `MERGE_BY_ID` precisely so the replay lands on the row that may
          // already exist (DEC-111).
          operationId: key,
        }),
      scheduleCreate: (itemId: string, body: ScheduleBody, key: string): Promise<boolean> =>
        queue({
          entityType: 'medicine_schedule',
          // The medicine, because that is what `POST /v1/items/:id/schedules` is addressed to and
          // the schedule has no ID until the server has written one. The same value the shelf
          // queues under.
          entityId: itemId,
          mutation: 'CREATE',
          payload: body,
          // A create has nothing to be conditional on (`13`'s precondition is for mutable records).
          baseVersion: null,
          operationId: key,
        }),
      scheduleUpdate: (scheduleId: string, body: ScheduleChangeBody): Promise<boolean> =>
        queue({
          entityType: 'medicine_schedule',
          // The schedule, because `PATCH /v1/schedules/:id` is addressed to it. The same value the
          // shelf queues under.
          entityId: scheduleId,
          mutation: 'UPDATE',
          payload: body,
          // The version the change was made against, freshly read moments ago. No idempotency key:
          // a conditional write is already exactly-once for its intent, and a replay against a row
          // that has moved is a `VERSION_CONFLICT` a person is asked about rather than a win.
          baseVersion: body.expectedVersion,
        }),
    }),
    [queue],
  );

  const executor = useMemo(
    () => (client === null ? {} : createToolExecutor(client, bridge, queued, listPending)),
    [client, bridge, queued, listPending],
  );

  /** Add a line to the transcript, having put it through the Speech Gate first. */
  const speak = useCallback(
    (parts: readonly SpeechPart[], composedFrom: readonly string[]) => {
      const gated = gateSpeech(parts, composedFrom);
      // A refusal is itself said, from the closed set. Silence from a voice interface is a
      // failure rather than an answer: the person is not looking at the screen.
      const text = gated.ok ? gated.text : UTTERANCES.cannotDoThat;
      setSession((current) => {
        const spoken = resolvedProviders.synthesizer !== null;
        if (spoken) void resolvedProviders.synthesizer?.speak(text);
        return reduce(current, { kind: 'SAY', text, at: now(), id: nextId(), spoken }).session;
      });
    },
    [resolvedProviders, now, nextId],
  );

  const run = useCallback(
    async (call: ToolCall, confirmed: boolean) => {
      const outcome = await dispatch(call, { ...context, confirmed }, executor);
      if (outcome.kind === 'REFUSED') {
        speak([{ kind: 'UTTERANCE', key: utteranceForRefusal(outcome.refusal) }], []);
        setSession((current) => reduce(current, { kind: 'DONE', outcome: 'REFUSED' }).session);
        return;
      }
      const result = outcome.value as ToolResult | undefined;
      const lines = result?.spoken ?? [];
      // The named sentences first, then the facts. A tool that says "I have kept it here" is
      // describing the conversation, and the conversation's own words come from the closed set -
      // which is the channel a key resolves against and a composed string cannot.
      const named: SpeechPart[] = (result?.utterances ?? []).map(
        (key) => ({ kind: 'UTTERANCE', key }) as const,
      );
      const composed: SpeechPart[] = lines
        .filter((line) => line.trim() !== '')
        .map((line) => ({ kind: 'COMPOSED', text: line }) as const);
      const parts = [...named, ...composed];
      // "Done." only where the tool said nothing at all. A tool that answered with a refusal has
      // already said what happened, and appending "Done." to it would be two sentences describing
      // one outcome and disagreeing about it.
      speak(parts.length === 0 ? [{ kind: 'UTTERANCE', key: 'done' }] : parts, lines);
      // The bar reports what the turn came to, and a turn that reached a tool and executed it
      // came to `COMPLETED` (DEC-156). A refusal has already returned above with `REFUSED`.
      setSession((current) => reduce(current, { kind: 'DONE', outcome: 'COMPLETED' }).session);
    },
    [context, executor, speak],
  );

  const say = useCallback(
    (text: string) => {
      const at = now();
      setSession((current) => reduce(current, { kind: 'HEARD', text, at, id: nextId() }).session);

      // The screen's own sentences first, and matched **exactly**.
      //
      // This is not understanding and is not described as any: the panel shows the phrasings this
      // route offers, and saying one of them back word for word runs it. What it buys is that
      // contextual control works today, with no model and no recogniser (`BLK-012`) - "Show only
      // toothpaste" typed into the bar filters the shelf, because the shelf declared that action
      // and offered that sentence. A model, when there is one, reaches the same handler through
      // the same validation.
      const offered = screen.snapshot.actions.find(
        (action) => action.label.toLowerCase() === text.trim().toLowerCase(),
      );
      if (offered !== undefined) {
        runScreenActionRef.current(offered.id);
        return;
      }

      const agent = resolvedProviders.agent;
      if (agent === null) {
        // No model, so nothing is understood. Said rather than silently ignored, and it points at
        // the screen - which is the whole app and is working.
        speak([{ kind: 'UTTERANCE', key: 'notUnderstood' }], []);
        setSession((current) => reduce(current, { kind: 'DONE', outcome: 'REFUSED' }).session);
        return;
      }

      void agent
        .proposeTurn({
          said: text,
          history: session.transcript.map((entry) => entry.text),
          // Only what may be called by voice. The first of two mechanisms keeping a `TOUCH_ONLY`
          // tool out of reach: the agent is never told it exists as something to call.
          tools: voiceCallableTools(),
        })
        .then(
          (turn) => {
            if (turn.kind === 'CANCEL') {
              setSession((current) => reduce(current, { kind: 'CANCEL' }).session);
              speak([{ kind: 'UTTERANCE', key: 'cancelled' }], []);
              return;
            }
            if (turn.kind === 'CONFIRM') {
              // A spoken "yes" goes through the same door as the button, naming the armed
              // proposal - so it cannot land on a different one.
              setSession((current) => {
                const pending = current.pending;
                if (pending === null) return current;
                const transition = reduce(current, {
                  kind: 'CONFIRM',
                  proposalId: pending.id,
                  at: now(),
                });
                if (transition.released !== null) void run(transition.released.call, true);
                else speak([{ kind: 'UTTERANCE', key: 'confirmationExpired' }], []);
                return transition.session;
              });
              return;
            }
            if (turn.kind === 'SAY') {
              // Narrowed, never cast. `turn.utterance` is a raw string off a model completion
              // (`ports.ts`), and a cast changes the type while checking nothing - which is how
              // `Object.prototype.toString` came to be a sentence this app would say out loud.
              // An unrecognised key is the model proposing something malformed, which is not the
              // person's mistake and is reported as one Kynviora did not understand.
              if (!isUtteranceKey(turn.utterance)) {
                speak([{ kind: 'UTTERANCE', key: 'notUnderstood' }], []);
                return;
              }
              speak([{ kind: 'UTTERANCE', key: turn.utterance }], []);
              return;
            }

            const call: ToolCall = { name: turn.name, arguments: turn.arguments };
            const checked = checkCall(call, context);
            if (checked.kind === 'REFUSED') {
              speak([{ kind: 'UTTERANCE', key: utteranceForRefusal(checked.refusal) }], []);
              // A gate refusal is a turn that came to nothing, and the bar has to say so rather
              // than sitting on `Understanding` until the next sentence.
              setSession(
                (current) => reduce(current, { kind: 'DONE', outcome: 'REFUSED' }).session,
              );
              return;
            }
            if (checked.tool.confirmation === 'NONE') {
              void run(call, false);
              return;
            }
            const proposal: PendingProposal = {
              id: newIdempotencyKey(),
              call,
              tool: checked.tool,
              // Composed here, from the tool and its validated arguments. A model's description
              // of a model's proposal, checked by nobody, is not a consent.
              summary: summariseProposal(checked.tool, call, null),
              armedAt: now(),
            };
            setSession((current) => reduce(current, { kind: 'PROPOSE', proposal }).session);
            speak([{ kind: 'UTTERANCE', key: 'confirmPrompt' }], []);
          },
          () => {
            speak([{ kind: 'UTTERANCE', key: 'notUnderstood' }], []);
          },
        );
    },
    [resolvedProviders, session.transcript, context, speak, run, now, nextId, screen.snapshot],
  );

  const confirm = useCallback(
    (proposalId: string) => {
      setSession((current) => {
        const transition = reduce(current, { kind: 'CONFIRM', proposalId, at: now() });
        if (transition.released !== null) {
          void run(transition.released.call, true);
        } else if (transition.refusal === 'CONFIRMATION_EXPIRED') {
          speak([{ kind: 'UTTERANCE', key: 'confirmationExpired' }], []);
        }
        return transition.session;
      });
    },
    [now, run, speak],
  );

  const cancel = useCallback(() => {
    setSession((current) => reduce(current, { kind: 'CANCEL' }).session);
    speak([{ kind: 'UTTERANCE', key: 'cancelled' }], []);
  }, [speak]);

  /**
   * Ask the screen to do one of the things it offered (DEC-157).
   *
   * The sentence Kynviora says afterwards is the **screen's** `says`, composed by the screen and
   * passed to the Speech Gate as a composed line citing itself - which is exactly what
   * `composedFrom` is for. A model's description of what a screen did would be a sentence nobody
   * in this repository wrote, and the gate exists to refuse those (DEC-135).
   */
  const runScreenAction = useCallback(
    (actionId: string) => {
      const ran = screen.runAction(actionId);
      if (ran === null) {
        // Never offered, or offered and then withdrawn while the panel was open. Either way this
        // screen cannot do it now, and the honest answer is the same one a refused tool gets.
        speak([{ kind: 'UTTERANCE', key: 'cannotDoThat' }], []);
        setSession((current) => reduce(current, { kind: 'DONE', outcome: 'REFUSED' }).session);
        return;
      }
      speak([{ kind: 'COMPOSED', text: ran.says }], [ran.says]);
      setSession((current) => reduce(current, { kind: 'DONE', outcome: 'COMPLETED' }).session);
    },
    [screen, speak],
  );

  // `say` runs before `runScreenAction` is declared and needs to reach it, so it goes through a
  // ref rather than through a reordering that would put the action runner above the thing it
  // reports into. Assigned on every render, read only inside a callback.
  const runScreenActionRef = useRef(runScreenAction);
  runScreenActionRef.current = runScreenAction;

  const open = useCallback(() => {
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    // The transcript survives. It is the record of what was said and done, and somebody who
    // missed a sentence has to be able to reopen and read it back.
    setSession((current) => reduce(current, { kind: 'END' }).session);
    setIsOpen(false);
  }, []);

  const value = useMemo<VoiceContextValue>(
    () => ({
      session,
      isOpen,
      open,
      say,
      confirm,
      cancel,
      close,
      canListen: resolvedProviders.recognizer !== null,
      canSpeak: resolvedProviders.synthesizer !== null,
      phrasings: screenPhrasings(screen.snapshot),
      contextSummary: describeScreenContext(screen.snapshot),
      runScreenAction,
    }),
    [
      session,
      isOpen,
      open,
      say,
      confirm,
      cancel,
      close,
      resolvedProviders,
      screen.snapshot,
      runScreenAction,
    ],
  );

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

export function useVoice(): VoiceContextValue {
  const value = useContext(VoiceContext);
  if (value === null) {
    throw new Error('useVoice must be used inside a VoiceProvider');
  }
  return value;
}
