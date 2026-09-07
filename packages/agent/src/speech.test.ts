/**
 * What Kynviora may say out loud, and everything it may not.
 *
 * Spec references: `17` (a model never establishes a fact and never advises about a medicine),
 * `18` (forbidden claims), `09`, `02`, `15` (model output is untrusted input). DEC-135.
 *
 * The gate's whole claim is that there is no path by which a sentence about somebody's medicine
 * reaches their ears without having been composed by this repository. These tests are that claim,
 * written as attempts to get around it.
 */

import { describe, it, expect } from 'vitest';
import {
  UTTERANCES,
  gateSpeech,
  isUtterance,
  isUtteranceKey,
  type SpeechPart,
  type UtteranceKey,
} from './speech.js';
import { findForbiddenClaims } from '@kynviora/presentation';

const RESULT = [
  'Two medicines are recorded for Anita.',
  'Kynviora has no matched rule for this product within the coverage it has.',
];

describe('what may be spoken', () => {
  it('assembles a fixed utterance with text a tool result carried', () => {
    const parts: SpeechPart[] = [
      { kind: 'COMPOSED', text: RESULT[0] as string },
      { kind: 'UTTERANCE', key: 'confirmPrompt' },
    ];
    const gated = gateSpeech(parts, RESULT);
    expect(gated.ok).toBe(true);
    if (gated.ok) {
      expect(gated.text).toContain('Two medicines are recorded');
      expect(gated.text).toContain(UTTERANCES.confirmPrompt);
    }
  });

  it('refuses a sentence a model wrote, however plausible', () => {
    // The whole point. This sentence is true, harmless and well-phrased - and nothing composed it,
    // so it does not get said.
    const gated = gateSpeech([{ kind: 'COMPOSED', text: 'You have two medicines.' }], RESULT);
    expect(gated.ok).toBe(false);
    if (!gated.ok) expect(gated.refusal).toBe('NOT_FROM_A_TOOL_RESULT');
  });

  it('refuses a paraphrase of something that was in the result', () => {
    // Substring or fuzzy matching would let "no matched rule was found within coverage" become
    // "no rule found" - and the missing words are the ones doing the work.
    const gated = gateSpeech(
      [{ kind: 'COMPOSED', text: 'Kynviora has no matched rule for this product.' }],
      RESULT,
    );
    expect(gated.ok).toBe(false);
  });

  it('refuses an utterance key this build does not have', () => {
    const gated = gateSpeech([{ kind: 'UTTERANCE', key: 'reassure' as unknown as 'done' }], RESULT);
    expect(gated.ok).toBe(false);
    if (!gated.ok) expect(gated.refusal).toBe('UNKNOWN_UTTERANCE');
  });

  it('refuses saying nothing', () => {
    // Silence from a voice interface is a failure, not an answer: the person is not looking at
    // the screen, which is why they are talking to it.
    expect(gateSpeech([], RESULT).ok).toBe(false);
    expect(gateSpeech([{ kind: 'COMPOSED', text: '   ' }], ['   ']).ok).toBe(false);
  });

  it('is not fooled by an empty allowed set', () => {
    // An absence test over an empty input passes trivially (DEC-102). A tool result carrying
    // nothing must not make every composed part acceptable.
    expect(gateSpeech([{ kind: 'COMPOSED', text: 'anything at all' }], []).ok).toBe(false);
  });
});

describe('the forbidden-claim scan over the whole sentence', () => {
  it('refuses a combination that says something neither half said', () => {
    // Both halves pass their own scan. Together they are a safety claim, and this is the only
    // place the whole sentence exists.
    const composed = 'This product is';
    const gated = gateSpeech(
      [
        { kind: 'COMPOSED', text: composed },
        { kind: 'COMPOSED', text: 'safe' },
      ],
      [composed, 'safe'],
    );
    expect(gated.ok).toBe(false);
    if (!gated.ok) expect(gated.refusal).toBe('FORBIDDEN_CLAIM');
  });

  it('lets a limitation through, which is what the negation rule is for', () => {
    const line = 'Kynviora cannot say whether this product is safe for you.';
    // The scanner itself has to agree, or this test is asserting the gate rather than the rule.
    expect(findForbiddenClaims(line)).toHaveLength(0);
    expect(gateSpeech([{ kind: 'COMPOSED', text: line }], [line]).ok).toBe(true);
  });
});

describe('the fixed utterances', () => {
  it('carries no forbidden claim in any of them', () => {
    for (const [key, text] of Object.entries(UTTERANCES)) {
      expect(findForbiddenClaims(text), `${key}: ${text}`).toHaveLength(0);
    }
  });

  it('says nothing about whether anything is safe, advisable or a good idea', () => {
    // A word test over the closed set, because this is the set somebody will one day want to add
    // a reassuring sentence to.
    for (const text of Object.values(UTTERANCES)) {
      const lower = text.toLowerCase();
      for (const fragment of [
        ' safe',
        'unsafe',
        'dangerous',
        'you should',
        'i recommend',
        'fine',
      ]) {
        expect(lower, text).not.toContain(fragment);
      }
    }
  });

  it('points at the screen wherever it refuses', () => {
    // A refusal that says only "no" is a dead end for somebody who cannot see what to do instead.
    // `18` requires a refusal to say what to do next.
    for (const key of ['cannotDoThat', 'touchOnly', 'needsIdentity'] as const) {
      expect(UTTERANCES[key].toLowerCase()).toContain('screen');
    }
  });

  it('recognises its own utterances and nothing else', () => {
    expect(isUtterance(UTTERANCES.done)).toBe(true);
    expect(isUtterance('Done')).toBe(false);
    expect(isUtterance('')).toBe(false);
  });

  it('has one sentence for the question this app will never answer', () => {
    // "Is this safe?" is the question a voice interface will be asked most, and the answer has to
    // exist as a fixed sentence rather than as something composed in the moment.
    expect(UTTERANCES.notMedicalAdvice).toContain('health professional');
  });
});

describe('an utterance key that is not one', () => {
  /**
   * Spec references: `17` (a model completion is untrusted input), `15`, DEC-135, `DEV-081`.
   *
   * **`Object.freeze` does not remove a prototype.** `UTTERANCES['toString']` is not `undefined` -
   * it is `Object.prototype.toString`, and `String()` of it is
   * `"function toString() { [native code] }"`. The gate's first draft resolved a key by index and
   * refused only on `undefined`, so every inherited name passed.
   *
   * That mattered because **the key is not this repository's to choose**: an agent turn of kind
   * `SAY` carries `utterance` as a raw string off a model completion (`ports.ts`). A model
   * returning `{ kind: 'SAY', utterance: 'toString' }` had a sentence spoken aloud that nothing
   * here composed - against a module whose stated property is that no such path exists, "including
   * a jailbroken or prompt-injected one".
   */
  const INHERITED = [
    'toString',
    'constructor',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    '__proto__',
  ] as const;

  it('refuses every name inherited from Object.prototype', () => {
    for (const name of INHERITED) {
      const gated = gateSpeech([{ kind: 'UTTERANCE', key: name as UtteranceKey }], []);
      expect(gated.ok, name).toBe(false);
      if (!gated.ok) expect(gated.refusal, name).toBe('UNKNOWN_UTTERANCE');
    }
  });

  it('never lets native code reach the assembled text', () => {
    // The assertion that would have failed loudly. A refusal is the mechanism; a sentence
    // containing "[native code]" is the harm, and it is worth naming separately because a future
    // resolution that returned some other non-string would satisfy the test above and not this.
    for (const name of INHERITED) {
      const gated = gateSpeech([{ kind: 'UTTERANCE', key: name as UtteranceKey }], []);
      if (gated.ok) expect(gated.text, name).not.toContain('native code');
    }
  });

  it('still accepts every key the closed set really has', () => {
    // The positive control. A gate that refused everything would satisfy both tests above, and it
    // would be a voice interface that has gone silent - which is a failure rather than an answer.
    for (const key of Object.keys(UTTERANCES) as UtteranceKey[]) {
      expect(gateSpeech([{ kind: 'UTTERANCE', key }], []).ok, key).toBe(true);
    }
  });

  it('narrows a name the same way it resolves one', () => {
    // `isUtteranceKey` is what the shell uses instead of a cast, so the two must agree - a
    // narrowing that admitted what the gate refuses would move the hole rather than close it.
    for (const name of INHERITED) expect(isUtteranceKey(name), name).toBe(false);
    for (const key of Object.keys(UTTERANCES)) expect(isUtteranceKey(key), key).toBe(true);
  });
});
