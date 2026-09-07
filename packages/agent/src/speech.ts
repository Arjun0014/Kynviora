/**
 * The Speech Gate: what a voice interface is allowed to say out loud.
 *
 * Spec references: `17` (a model proposes; it never establishes a fact, and it never advises
 * starting, stopping or replacing a medicine), `09` (evidence and urgency are separate; a
 * limitation travels with the statement it qualifies), `18` (forbidden claims; safety copy has a
 * structure), `02` (no universal safe/unsafe judgement), `15` (a model's output is untrusted
 * input). DEC-135.
 *
 * THE PROBLEM THIS SOLVES
 * A conversational agent's whole appeal is that it phrases things itself. On a screen that is a
 * feature; about somebody's medicine it is the failure `17` is written to prevent. A model asked
 * "what are these tablets for?" will answer, fluently, from its own weights - and nothing in the
 * answer came from a source, a rule, or a reviewer.
 *
 * THE RULE
 * **Every fact Kynviora speaks came out of a tool result. Every other word came from a closed
 * set of phrasings in this file.** The agent chooses which tool to call and which phrasing to
 * use; it supplies no prose of its own. This is the Citation Gate's argument applied to speech:
 * the model proposes, and something that is not the model decides what may be said.
 *
 * WHAT THAT COSTS AND WHY IT IS WORTH IT
 * It costs fluency. Kynviora will sound composed rather than chatty, and it cannot answer a
 * question no tool answers - it says so instead. What it buys is that there is no path, including
 * a jailbroken or prompt-injected one, by which a sentence about somebody's medicine reaches
 * their ears without having been composed by this repository. A package photograph, a webpage and
 * a regulatory PDF are all untrusted input that may contain instructions (`17`); so is a model's
 * completion, and the gate treats all four the same way.
 */

import { findForbiddenClaims } from '@kynviora/presentation';

/**
 * Every sentence Kynviora may say that did not come from a tool result.
 *
 * Closed, and every one of them is about the **conversation** rather than about a medicine. There
 * is no member of this set that says anything is safe, unsafe, advisable, or a good idea.
 */
export const UTTERANCES = Object.freeze({
  listening: 'I am listening.',
  notUnderstood: 'I did not catch that. You can also do this by touching the screen.',
  // Said when no tool matches. Deliberately does not guess, and deliberately points at the part
  // of the app that can answer.
  cannotDoThat: 'I cannot do that by voice. You can do it on the screen, and I can take you there.',
  cannotAnswerThat:
    'That is not something Kynviora keeps a record of, so I have nothing to read you.',
  // The three refusals a person will actually meet.
  touchOnly:
    'This one needs the screen rather than your voice. I have opened it - the control is there.',
  needsIdentity:
    'This needs you to confirm who you are first, and that has to be typed. I have opened the screen.',
  offline: 'This phone has no connection at the moment, so I cannot ask the server about that.',
  queued: 'This phone has no connection, so I have kept it here and it will be sent when there is.',
  blocked: 'That part of Kynviora is not finished yet, so there is nothing for me to read you.',
  /**
   * Said when **this app** knows the caller does not hold the capability.
   *
   * Not for a `404`. The API answers absence and refused access identically on purpose (`13`), so
   * a sentence naming a refusal would assert the one reading the server declined to give - see
   * `notAvailable`.
   */
  notAllowed: 'You do not have access to that.',
  /**
   * Said for a `404`, in the words the screen uses for the same answer.
   *
   * "Not available. Kynviora has nothing to show here." is what `presentScreenState` renders, and
   * this is that sentence in the conversation's register. It commits to nothing about why, which
   * is the whole reason the API makes absence and refusal indistinguishable.
   */
  notAvailable: 'Kynviora has nothing to show for that.',
  /**
   * Said when a request reached the server and did not succeed for any other reason.
   *
   * The second half is doing the work. A person who is not looking at the screen has to hear that
   * nothing was kept - otherwise they stop thinking about a record that does not exist, and there
   * is no later moment at which they find out (`DEV-055`, `LOW-2`).
   */
  didNotGoThrough: 'That did not go through, and Kynviora has not kept it. Nothing has changed.',
  // Confirmation.
  confirmPrompt: 'Shall I do that? Say yes, or press the large button.',
  confirmationExpired:
    'That was a while ago, so I have not done it. Ask me again if you still want to.',
  cancelled: 'I have not done it.',
  done: 'Done.',
  // The one thing a health app must be able to say and must never be clever about.
  notMedicalAdvice:
    'I only read out what is written down here. Anything about whether to take a medicine is for you and a health professional.',
});

export type UtteranceKey = keyof typeof UTTERANCES;

const UTTERANCE_VALUES: ReadonlySet<string> = new Set(Object.values(UTTERANCES));

/**
 * What a spoken response is made of.
 *
 * `utterance` is a key into {@link UTTERANCES}. `composed` is text a tool result carried, which
 * the presentation layer had already written. Nothing else is representable.
 */
export type SpeechPart =
  | { readonly kind: 'UTTERANCE'; readonly key: UtteranceKey }
  | { readonly kind: 'COMPOSED'; readonly text: string };

/** Why a response was refused. */
export const SPEECH_REFUSALS = [
  /** A part claimed to be composed but did not appear in the tool result it cited. */
  'NOT_FROM_A_TOOL_RESULT',
  /** A part named an utterance this build does not have. */
  'UNKNOWN_UTTERANCE',
  /** The assembled text contains a claim `18` forbids. */
  'FORBIDDEN_CLAIM',
  /** Nothing to say. A silent response from a voice interface is a failure, not an answer. */
  'EMPTY',
] as const;
export type SpeechRefusal = (typeof SPEECH_REFUSALS)[number];

export type GatedSpeech =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly refusal: SpeechRefusal; readonly detail: string };

/**
 * Assemble a spoken response, or refuse it.
 *
 * `composedFrom` is the set of strings the tool result actually carried. A `COMPOSED` part must
 * appear in it - **exactly**, not as a paraphrase - which is what stops a model rewriting a
 * limitation into something shorter. Substring matching would be enough to let "no matched rule
 * was found" become "no rule found", and the missing word is the one doing the work.
 */
export function gateSpeech(
  parts: readonly SpeechPart[],
  composedFrom: readonly string[],
): GatedSpeech {
  if (parts.length === 0) return { ok: false, refusal: 'EMPTY', detail: 'no parts' };

  const allowed = new Set(composedFrom.map((entry) => entry.trim()).filter((e) => e !== ''));
  const pieces: string[] = [];

  for (const part of parts) {
    if (part.kind === 'UTTERANCE') {
      const text = UTTERANCES[part.key] as string | undefined;
      if (text === undefined) {
        return { ok: false, refusal: 'UNKNOWN_UTTERANCE', detail: String(part.key) };
      }
      pieces.push(text);
      continue;
    }

    const text = part.text.trim();
    if (!allowed.has(text)) {
      return { ok: false, refusal: 'NOT_FROM_A_TOOL_RESULT', detail: text };
    }
    pieces.push(text);
  }

  const assembled = pieces.join(' ').trim();
  if (assembled === '') return { ok: false, refusal: 'EMPTY', detail: 'assembled to nothing' };

  // Belt and braces, and worth the cost. Every part is already either a fixed utterance or copy
  // the presentation layer composed, and both of those are scanned by their own tests - but a
  // **combination** can say something neither half said, and this is the only place the whole
  // sentence exists.
  const forbidden = findForbiddenClaims(assembled);
  if (forbidden.length > 0) {
    return {
      ok: false,
      refusal: 'FORBIDDEN_CLAIM',
      detail: forbidden.map((claim) => claim.rule).join(', '),
    };
  }

  return { ok: true, text: assembled };
}

/** Whether a string is one of the fixed utterances. Used by tests and by the transcript view. */
export function isUtterance(text: string): boolean {
  return UTTERANCE_VALUES.has(text);
}
