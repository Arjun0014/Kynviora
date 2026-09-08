/**
 * A voice conversation, as a state machine with one armed action at a time.
 *
 * Spec references: `18` (a person knows what they are agreeing to; status announced without
 * interrupting), `14` (high-impact actions are confirmed), `12` (offline is a state, not an
 * error), `17`. DEC-134.
 *
 * WHY A STATE MACHINE AND NOT A FLAG
 * "Awaiting confirmation" is not a boolean on a screen. It is a state in which exactly one
 * proposal is armed, the proposal is the one whose summary was read out, and anything else the
 * person says cancels it rather than confirming it. Written as a flag, the failure is the one
 * every voice assistant has had: a "yes" meant for something else executes something the person
 * never heard described.
 *
 * THE FOUR RULES THIS MACHINE EXISTS TO KEEP
 *
 *  1. **A confirmation is for one proposal.** `confirm` takes the proposal's own id, and a
 *     confirmation for a different id is refused rather than applied to whatever is armed.
 *  2. **A confirmation expires.** Somebody who put the phone down and came back an hour later
 *     must not find an action still waiting for a word. The window is short and is checked
 *     against a clock the caller supplies, never against the device's own.
 *  3. **Anything not a confirmation cancels.** A new request while a proposal is armed disarms
 *     it. There is no path where a proposal survives the person changing the subject.
 *  4. **The summary the person heard is stored with the proposal.** What was confirmed is what
 *     was said, and a later step cannot substitute a different description of the same call.
 */

import type { ToolCall, ToolDefinition } from './tools.js';

/**
 * Where a conversation is.
 *
 * `IDLE` - nothing happening; the microphone is off.
 * `LISTENING` - the microphone is open and the person is being heard.
 * `THINKING` - a turn has been sent to the agent and no answer has come back.
 * `SPEAKING` - a response is being read out.
 * `AWAITING_CONFIRMATION` - exactly one proposal is armed and its summary has been given.
 * `WORKING` - a confirmed call is being executed.
 */
export const VOICE_STATES = [
  'IDLE',
  'LISTENING',
  'THINKING',
  'SPEAKING',
  'AWAITING_CONFIRMATION',
  'WORKING',
] as const;
export type VoiceState = (typeof VOICE_STATES)[number];

/** One armed proposal, and the words the person was actually given about it. */
export interface PendingProposal {
  /** Unique per proposal. A confirmation names it, so a stale "yes" cannot land on a new one. */
  readonly id: string;
  readonly call: ToolCall;
  readonly tool: ToolDefinition;
  /**
   * The summary that was spoken and shown.
   *
   * Stored rather than recomputed. What somebody agreed to is the sentence they heard, and a
   * summary regenerated at execution time is a different sentence about the same call.
   */
  readonly summary: string;
  /** Epoch milliseconds, from the caller's clock. */
  readonly armedAt: number;
}

/**
 * How long an armed proposal stays armed.
 *
 * Ninety seconds. Long enough to think about a sentence read out slowly at a large font scale,
 * short enough that a phone left on a table is not holding a live "yes" for a medicine record.
 */
export const CONFIRMATION_WINDOW_MS = 90_000;

/** One line in the transcript, which is the accessible half of a voice interface. */
export interface TranscriptEntry {
  readonly id: string;
  readonly speaker: 'PERSON' | 'KYNVIORA';
  readonly text: string;
  readonly at: number;
  /**
   * Whether this line was **spoken** as well as shown.
   *
   * A refusal that was only shown and a refusal that was read out are different events for
   * somebody who is not looking at the screen, and the transcript has to be able to say which.
   */
  readonly spoken: boolean;
}

/**
 * How the last turn ended, once it has ended.
 *
 * `VoiceState` says what the conversation is *doing*; this says what the last thing it did came
 * to. The two are different questions and the persistent Talk bar needs both: it returns to
 * `IDLE` after every turn, and "idle having just recorded a dose", "idle having refused", and
 * "idle having asked for a missing detail" are three different sentences to put on a bar
 * (DEC-156).
 *
 * `NEEDS_MORE` is the one worth naming separately from `REFUSED`. "I cannot do that" ends the
 * exchange; "which medicine did you mean" continues it, and a bar that said the first when it
 * meant the second would stop a person who was one word away from being understood.
 */
export const TURN_OUTCOMES = ['COMPLETED', 'REFUSED', 'NEEDS_MORE'] as const;
export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

export interface VoiceSession {
  readonly state: VoiceState;
  readonly transcript: readonly TranscriptEntry[];
  /** The armed proposal, or `null`. Non-null exactly in `AWAITING_CONFIRMATION`. */
  readonly pending: PendingProposal | null;
  /** Which profile the conversation is about, so a tool call cannot silently change subject. */
  readonly profileId: string | null;
  /**
   * How the last completed turn ended, or `null` before there has been one.
   *
   * Cleared the moment a new turn starts, because a bar still reporting the previous outcome
   * while a new sentence is being heard is describing something that is no longer happening.
   */
  readonly lastOutcome: TurnOutcome | null;
}

export function emptySession(profileId: string | null): VoiceSession {
  return { state: 'IDLE', transcript: [], pending: null, profileId, lastOutcome: null };
}

/** Everything that can happen to a conversation. Closed, so nothing arrives unhandled. */
export type VoiceEvent =
  | { readonly kind: 'START_LISTENING' }
  | { readonly kind: 'STOP_LISTENING' }
  | { readonly kind: 'HEARD'; readonly text: string; readonly at: number; readonly id: string }
  | { readonly kind: 'THINKING' }
  | {
      readonly kind: 'SAY';
      readonly text: string;
      readonly at: number;
      readonly id: string;
      readonly spoken: boolean;
    }
  | { readonly kind: 'PROPOSE'; readonly proposal: PendingProposal }
  | { readonly kind: 'CONFIRM'; readonly proposalId: string; readonly at: number }
  | { readonly kind: 'CANCEL' }
  | { readonly kind: 'WORKING' }
  | { readonly kind: 'DONE'; readonly outcome?: TurnOutcome }
  | { readonly kind: 'END' };

/** Why an event did not do what it looked like it would. */
export const VOICE_TRANSITION_REFUSALS = [
  /** A confirmation arrived with nothing armed. */
  'NOTHING_TO_CONFIRM',
  /** A confirmation named a proposal that is not the armed one. */
  'WRONG_PROPOSAL',
  /** The armed proposal had been waiting longer than {@link CONFIRMATION_WINDOW_MS}. */
  'CONFIRMATION_EXPIRED',
] as const;
export type VoiceTransitionRefusal = (typeof VOICE_TRANSITION_REFUSALS)[number];

export interface Transition {
  readonly session: VoiceSession;
  /**
   * The proposal this transition released for execution, or `null`.
   *
   * The **only** way a call reaches the dispatcher. A caller cannot execute `session.pending`
   * itself, because by the time it could the machine has already disarmed it.
   */
  readonly released: PendingProposal | null;
  readonly refusal: VoiceTransitionRefusal | null;
}

function withTranscript(session: VoiceSession, entry: TranscriptEntry): VoiceSession {
  return { ...session, transcript: [...session.transcript, entry] };
}

/**
 * Apply one event.
 *
 * Pure, and total over the union. The session is data - the screen renders it, the tests assert
 * over it, and nothing about it needs a microphone.
 */
export function reduce(session: VoiceSession, event: VoiceEvent): Transition {
  const unchanged = (refusal: VoiceTransitionRefusal | null = null): Transition => ({
    session,
    released: null,
    refusal,
  });

  switch (event.kind) {
    case 'START_LISTENING':
      // Opening the microphone cancels anything armed. A person who starts talking again has
      // changed the subject, and a proposal that survived that is one waiting to catch a "yes"
      // meant for something else.
      return {
        session: { ...session, state: 'LISTENING', pending: null, lastOutcome: null },
        released: null,
        refusal: null,
      };

    case 'STOP_LISTENING':
      return {
        session: { ...session, state: session.pending === null ? 'IDLE' : 'AWAITING_CONFIRMATION' },
        released: null,
        refusal: null,
      };

    case 'HEARD':
      return {
        session: withTranscript(
          { ...session, state: 'THINKING', lastOutcome: null },
          { id: event.id, speaker: 'PERSON', text: event.text, at: event.at, spoken: false },
        ),
        released: null,
        refusal: null,
      };

    case 'THINKING':
      return { session: { ...session, state: 'THINKING' }, released: null, refusal: null };

    case 'SAY':
      return {
        session: withTranscript(
          // Saying something while a proposal is armed keeps it armed: the proposal's summary and
          // a follow-up sentence about it are one turn.
          { ...session, state: session.pending === null ? 'SPEAKING' : 'AWAITING_CONFIRMATION' },
          {
            id: event.id,
            speaker: 'KYNVIORA',
            text: event.text,
            at: event.at,
            spoken: event.spoken,
          },
        ),
        released: null,
        refusal: null,
      };

    case 'PROPOSE':
      return {
        session: { ...session, state: 'AWAITING_CONFIRMATION', pending: event.proposal },
        released: null,
        refusal: null,
      };

    case 'CONFIRM': {
      const pending = session.pending;
      if (pending === null) return unchanged('NOTHING_TO_CONFIRM');
      if (pending.id !== event.proposalId) {
        // Disarmed as well as refused. A confirmation naming the wrong proposal means the two
        // sides disagree about what is on the table, and the safe reading of that is neither.
        return {
          session: { ...session, state: 'IDLE', pending: null },
          released: null,
          refusal: 'WRONG_PROPOSAL',
        };
      }
      if (event.at - pending.armedAt > CONFIRMATION_WINDOW_MS) {
        return {
          session: { ...session, state: 'IDLE', pending: null },
          released: null,
          refusal: 'CONFIRMATION_EXPIRED',
        };
      }
      // Released and disarmed in the same step, so a second confirmation of the same proposal
      // finds nothing armed rather than running it twice.
      return {
        session: { ...session, state: 'WORKING', pending: null },
        released: pending,
        refusal: null,
      };
    }

    case 'CANCEL':
      return {
        session: { ...session, state: 'IDLE', pending: null },
        released: null,
        refusal: null,
      };

    case 'WORKING':
      return { session: { ...session, state: 'WORKING' }, released: null, refusal: null };

    case 'DONE':
      return {
        // An outcome the caller did not name leaves the previous one alone rather than clearing
        // it. `DONE` is issued from several places and only some of them know how the turn went;
        // overwriting with `null` there would erase a report a person has not read yet.
        session: {
          ...session,
          state: 'IDLE',
          ...(event.outcome === undefined ? {} : { lastOutcome: event.outcome }),
        },
        released: null,
        refusal: null,
      };

    case 'END':
      // The transcript survives ending a conversation: it is the accessible record of what was
      // said and done, and a person who missed a sentence has to be able to read it back.
      return {
        session: { ...session, state: 'IDLE', pending: null },
        released: null,
        refusal: null,
      };
  }
}

/** Whether a proposal armed at one moment is still live at another. */
export function proposalIsLive(proposal: PendingProposal, now: number): boolean {
  return now - proposal.armedAt <= CONFIRMATION_WINDOW_MS;
}
