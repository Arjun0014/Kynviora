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
 * The server, as it last answered. `mayRecordDoses` from the shelf and `mayEdit`/`mayDelete` from
 * the item detail are already the app's honest picture of what this caller may do; the dispatch
 * context is assembled from those rather than from anything guessed here. That does not authorise
 * anything - the route decides, every time, on the session (`11`, `13`) - it stops the agent
 * offering something the write would refuse, which is what `mayRecordDoses` already does on the
 * shelf (DEC-116).
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
  dispatch,
  emptySession,
  gateSpeech,
  reduce,
  summariseProposal,
  utteranceForRefusal,
  UTTERANCES,
  voiceCallableTools,
  type DispatchContext,
  type PendingProposal,
  type SpeechPart,
  type ToolCall,
  type ToolCapability,
  type VoiceProviders,
  type VoiceSession,
} from '@kynviora/agent';
import { useApi } from '@/api/ApiProvider';
import { useProfiles } from '@/api/ProfileProvider';
import { createToolExecutor, type ToolResult, type VoiceBridge } from './executor';
import { resolveVoiceProviders } from './devScript';
import { capabilitiesFor } from './capabilities';
import { newIdempotencyKey } from '@/platform/ids';

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
        },
        activeProfileId,
        null,
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

  const context = useMemo<DispatchContext>(
    () => ({
      // Derived from what the server said rather than assumed (`DEV-074`). This authorises
      // nothing: the route checks again, on the session, every time.
      capabilities: capabilities ?? capabilitiesFor({ isOwner: owns }),
      isOwner: owns,
      // Always false. Nothing in this build can re-authenticate by voice, and every tool that
      // needs it is `TOUCH_ONLY` anyway - so this is the second of two mechanisms rather than the
      // only one (`14`).
      stepUpFresh: false,
      online,
      origin: 'VOICE',
      confirmed: false,
    }),
    [capabilities, owns, online],
  );

  const executor = useMemo(
    () =>
      client === null
        ? {}
        : createToolExecutor(client, bridge, (_call: ToolCall, _key: string) => {
            // The journal is wired to the dose sheet rather than here (`DEV-071`): what this build
            // can honestly say is that the server did not take it.
            void _call;
            void _key;
            return Promise.resolve(UTTERANCES.offline);
          }),
    [client, bridge],
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
        setSession((current) => reduce(current, { kind: 'DONE' }).session);
        return;
      }
      const lines = (outcome.value as ToolResult | undefined)?.spoken ?? [];
      const parts: SpeechPart[] =
        lines.length === 0
          ? [{ kind: 'UTTERANCE', key: 'done' }]
          : lines
              .filter((line) => line.trim() !== '')
              .map((line) => ({ kind: 'COMPOSED', text: line }) as const);
      speak(parts.length === 0 ? [{ kind: 'UTTERANCE', key: 'done' }] : parts, lines);
      setSession((current) => reduce(current, { kind: 'DONE' }).session);
    },
    [context, executor, speak],
  );

  const say = useCallback(
    (text: string) => {
      const at = now();
      setSession((current) => reduce(current, { kind: 'HEARD', text, at, id: nextId() }).session);

      const agent = resolvedProviders.agent;
      if (agent === null) {
        // No model, so nothing is understood. Said rather than silently ignored, and it points at
        // the screen - which is the whole app and is working.
        speak([{ kind: 'UTTERANCE', key: 'notUnderstood' }], []);
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
              const key = turn.utterance as keyof typeof UTTERANCES;
              speak([{ kind: 'UTTERANCE', key }], []);
              return;
            }

            const call: ToolCall = { name: turn.name, arguments: turn.arguments };
            const checked = checkCall(call, context);
            if (checked.kind === 'REFUSED') {
              speak([{ kind: 'UTTERANCE', key: utteranceForRefusal(checked.refusal) }], []);
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
    [resolvedProviders, session.transcript, context, speak, run, now, nextId],
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
    }),
    [session, isOpen, open, say, confirm, cancel, close, resolvedProviders],
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
