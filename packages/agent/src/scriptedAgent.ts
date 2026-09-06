/**
 * A conversational agent that is not one, so the rest of Voice Mode can be tested.
 *
 * Spec references: `19` (deterministic fixtures; no real health data in testing), `17` (no
 * provider is chosen here), DEC-136, `BLK-012`.
 *
 * WHAT THIS IS
 * A phrase matcher. It holds a list of patterns, each mapped to a tool call with the arguments
 * written out, and returns the first one that matches. It has no model, no network and no
 * understanding, and it is **named for what it is** so nobody reads a passing test as evidence
 * that Kynviora can hold a conversation.
 *
 * WHY IT IS WORTH HAVING ANYWAY
 * Everything between the agent and the person is real: the registry, the six gates, the
 * confirmation machine, the Speech Gate, the navigation bridge and the executor that calls the
 * same client a screen calls. A scripted agent exercises all of it end to end, deterministically,
 * in CI, on a machine with no microphone - which is exactly the half that has to keep working
 * whichever provider is eventually chosen.
 *
 * WHAT IT ESTABLISHES AND WHAT IT DOES NOT
 * It establishes that a proposal for tool X with arguments Y is validated, confirmed, executed,
 * and reported correctly. It establishes **nothing** about whether a real model would propose
 * that tool for that sentence, which is the interesting and unmeasured half - and it is unmeasured
 * because there is no provider, not because nobody looked.
 *
 * A DELIBERATE PROPERTY: IT IS ALLOWED TO MISBEHAVE
 * The scripts include ones that propose a `TOUCH_ONLY` tool, invent an argument, and name a tool
 * that does not exist. A fake that only ever proposes valid calls would test the happy path of a
 * boundary whose whole purpose is the unhappy one - and a real model, or a prompt-injected one,
 * will produce every shape in here.
 */

import type { AgentTurn, AgentTurnRequest, ConversationAgent } from './ports.js';

export interface ScriptedRule {
  /** Matched against the lower-cased transcript, trimmed. */
  readonly whenSaid: RegExp;
  readonly then: AgentTurn;
}

/**
 * Create an agent from a script.
 *
 * First match wins, in order. Nothing said that matches nothing produces `SAY notUnderstood`,
 * which is what a real agent should also do rather than guessing.
 */
export function createScriptedAgent(rules: readonly ScriptedRule[]): ConversationAgent {
  return {
    proposeTurn(request: AgentTurnRequest): Promise<AgentTurn> {
      const said = request.said.trim().toLowerCase();
      for (const rule of rules) {
        if (rule.whenSaid.test(said)) return Promise.resolve(rule.then);
      }
      return Promise.resolve({ kind: 'SAY', utterance: 'notUnderstood' });
    },
  };
}

/**
 * A script covering the journeys Voice Mode is meant to support, plus the ones it must refuse.
 *
 * The identifiers are placeholders a test substitutes. They are deliberately obvious rather than
 * plausible: a fixture that looked like a real medicine ID is one somebody eventually pastes
 * somewhere real.
 */
export function demonstrationScript(profileId: string, itemId: string): readonly ScriptedRule[] {
  return [
    {
      whenSaid: /what (medicines|medication|tablets) am i (taking|on)/,
      then: { kind: 'CALL', name: 'list_medicines', arguments: { profileId } },
    },
    {
      whenSaid: /what (else )?(do you need|is missing)/,
      then: { kind: 'CALL', name: 'explain_what_is_missing', arguments: { itemId } },
    },
    {
      whenSaid: /i (took|have taken) (it|them)/,
      then: {
        kind: 'CALL',
        name: 'record_dose',
        arguments: { itemId, eventKind: 'TAKEN' },
      },
    },
    {
      whenSaid: /i (skipped|missed) (it|them|that one)/,
      then: {
        kind: 'CALL',
        name: 'record_dose',
        arguments: { itemId, eventKind: 'SKIPPED' },
      },
    },
    {
      whenSaid: /remind me at (eight|8)/,
      then: {
        kind: 'CALL',
        name: 'create_schedule',
        arguments: { itemId, timesOfDay: '08:00', timeZone: 'Asia/Kolkata' },
      },
    },
    {
      whenSaid: /(open|show me|go to) (the )?shelf/,
      then: { kind: 'CALL', name: 'open_screen', arguments: { screen: 'SHELF' } },
    },
    {
      whenSaid: /(scan|photograph|take a picture of) (the )?(box|packet|package)/,
      then: {
        kind: 'CALL',
        name: 'start_package_capture',
        arguments: { profileId, panel: 'FRONT' },
      },
    },
    {
      whenSaid: /what does the (box|label|packet) say/,
      then: { kind: 'CALL', name: 'read_extracted_fields', arguments: {} },
    },
    {
      whenSaid: /(is|are) (it|they|this) safe/,
      // The one question this app will never answer, and the fake asks it too - because the
      // interesting assertion is what happens next.
      then: { kind: 'SAY', utterance: 'notMedicalAdvice' },
    },
    // --- the ones a real model will also produce -------------------------------------------
    {
      whenSaid: /delete my account/,
      then: { kind: 'CALL', name: 'delete_account', arguments: {} },
    },
    {
      whenSaid: /give my daughter access/,
      then: { kind: 'CALL', name: 'invite_caregiver', arguments: { profileId } },
    },
    {
      whenSaid: /remove (that|this) (medicine|item)/,
      then: { kind: 'CALL', name: 'delete_item', arguments: { itemId } },
    },
    {
      whenSaid: /double (the|my) dose/,
      // No such tool, which is the point: the vocabulary has no way to express it.
      then: { kind: 'CALL', name: 'change_dose', arguments: { itemId, multiplier: 2 } },
    },
    {
      whenSaid: /show me everything for everyone/,
      // A tool that exists, with an argument it does not take.
      then: {
        kind: 'CALL',
        name: 'list_medicines',
        arguments: { profileId, includeOtherHouseholds: true },
      },
    },
    { whenSaid: /^yes$/, then: { kind: 'CONFIRM' } },
    { whenSaid: /^(no|cancel|stop)$/, then: { kind: 'CANCEL' } },
  ];
}
