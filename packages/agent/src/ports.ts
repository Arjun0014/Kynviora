/**
 * The three providers Voice Mode needs and this build does not have.
 *
 * Spec references: `17` (provider selection is a decision with a privacy review attached), `16`
 * (a model/data privacy review is required before any provider sees health content), `11`
 * (dependency inversion), `23` (provider strategy is a recorded decision, not an engineering
 * choice made in passing). `BLK-012`.
 *
 * WHY THESE ARE PORTS WITH NOTHING BEHIND THEM
 * Speech recognition, a conversational model and speech synthesis are three separate purchases,
 * each of which would receive **health content spoken in somebody's home**. `16` requires a
 * model and data privacy review before any of that happens, and `23` lists provider strategy
 * among the decisions that are made and recorded rather than arrived at. Picking one to make
 * progress would be exactly the fabrication the operating brief forbids.
 *
 * So the interfaces are here, everything that does not need them is built and tested, and the
 * one implementation in the repository is a **deterministic script** that matches phrases - which
 * is honest about being a fake and is what lets the whole pipeline run in CI.
 *
 * WHAT AN IMPLEMENTATION WOULD HAVE TO PROMISE
 * Written here rather than in a document, because it is what the next person needs:
 *
 *  - **The agent gets tools, never data.** `proposeTurn` receives the transcript and the list of
 *    callable tools, and returns a proposal. It is handed no session, no token, no profile
 *    contents and no database. It cannot be handed one: nothing in {@link AgentTurnRequest} is.
 *  - **Its output is untrusted.** `15` treats every uploaded document and webpage as a possible
 *    carrier of instructions; a model completion is the same class of thing. The dispatcher
 *    validates every proposal against the registry, and the Speech Gate refuses any word that did
 *    not come from a tool result or the fixed utterance set.
 *  - **Audio is health content.** Recognition and synthesis both handle a person saying the name
 *    of their medicine out loud. Where that audio goes, whether it is retained, and by whom, is
 *    the substance of the `16` review rather than a configuration detail.
 */

import type { ToolDefinition } from './tools.js';

/** Audio in, words out. */
export interface SpeechRecognizer {
  /** Begin listening. Resolves with the final transcript, or `null` if nothing was heard. */
  listen(): Promise<string | null>;
  /** Stop early, because the person pressed the button again. */
  stop(): void;
}

/** What the agent is given for one turn. Deliberately small, and deliberately not the person's data. */
export interface AgentTurnRequest {
  /** What the person just said. */
  readonly said: string;
  /**
   * The conversation so far, oldest first, as plain lines.
   *
   * Both sides' words and nothing else - no tool results, no identifiers, no record contents. A
   * model that needed a medicine's name to decide which tool to call would be a model being sent
   * health content to route a request, and routing does not need it: the tool takes an item ID,
   * and resolving a spoken name to one is a **tool call**, not a thing the model knows.
   */
  readonly history: readonly string[];
  /** Exactly the tools this caller may invoke by voice, right now. */
  readonly tools: readonly ToolDefinition[];
}

/**
 * What an agent may propose.
 *
 * Three shapes and no fourth. Notably there is no "say this sentence I wrote": an agent proposing
 * speech names an utterance key, and the words behind that key are in this repository.
 */
export type AgentTurn =
  | {
      readonly kind: 'CALL';
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'SAY'; readonly utterance: string }
  | { readonly kind: 'CONFIRM' }
  | { readonly kind: 'CANCEL' };

export interface ConversationAgent {
  proposeTurn(request: AgentTurnRequest): Promise<AgentTurn>;
}

/** Words out, sound out. */
export interface SpeechSynthesizer {
  /**
   * Say something.
   *
   * Everything reaching this has been through the Speech Gate. The synthesizer is a voice, not a
   * writer, and is given no opportunity to rephrase.
   */
  speak(text: string): Promise<void>;
  stop(): void;
}

/**
 * The three of them, or the absence of each.
 *
 * `null` is a supported state throughout: Voice Mode with no recogniser is a transcript and a set
 * of large buttons, which is a usable interface and is what this build ships.
 */
export interface VoiceProviders {
  readonly recognizer: SpeechRecognizer | null;
  readonly agent: ConversationAgent | null;
  readonly synthesizer: SpeechSynthesizer | null;
}

/** No providers at all. What the app runs with today. */
export const NO_PROVIDERS: VoiceProviders = Object.freeze({
  recognizer: null,
  agent: null,
  synthesizer: null,
});
