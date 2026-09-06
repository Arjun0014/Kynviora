/**
 * The confirmation machine, and the four ways a spoken "yes" goes wrong.
 *
 * Spec references: `18` (a person knows what they are agreeing to), `14`, `12`. DEC-134.
 *
 * Every failure in this file is one a voice assistant has actually shipped: a stale confirmation
 * catching a word meant for something else, a proposal that survived the person changing the
 * subject, a "yes" applied to whatever happened to be armed, and one word running an action
 * twice.
 */

import { describe, it, expect } from 'vitest';
import {
  CONFIRMATION_WINDOW_MS,
  emptySession,
  proposalIsLive,
  reduce,
  type PendingProposal,
  type VoiceSession,
} from './session.js';
import { toolNamed } from './registry.js';

const T0 = 1_760_000_000_000;

function proposal(id: string, at = T0): PendingProposal {
  const tool = toolNamed('record_dose');
  if (tool === null) throw new Error('record_dose must exist');
  return {
    id,
    call: { name: 'record_dose', arguments: { itemId: 'i1', eventKind: 'TAKEN' } },
    tool,
    summary: 'Record that you took it, for Tablet A.',
    armedAt: at,
  };
}

function armed(id = 'p1'): VoiceSession {
  return reduce(emptySession('profile-1'), { kind: 'PROPOSE', proposal: proposal(id) }).session;
}

describe('arming a proposal', () => {
  it('puts the conversation in exactly one state, with exactly one proposal', () => {
    const session = armed();
    expect(session.state).toBe('AWAITING_CONFIRMATION');
    expect(session.pending?.id).toBe('p1');
  });

  it('keeps the summary that was actually given', () => {
    // What somebody agreed to is the sentence they heard. A summary regenerated at execution time
    // is a different sentence about the same call.
    expect(armed().pending?.summary).toBe('Record that you took it, for Tablet A.');
  });
});

describe('confirming', () => {
  it('releases the proposal, once', () => {
    const session = armed();
    const first = reduce(session, { kind: 'CONFIRM', proposalId: 'p1', at: T0 + 1_000 });
    expect(first.released?.id).toBe('p1');
    expect(first.session.state).toBe('WORKING');
    expect(first.session.pending).toBeNull();

    // A second "yes" - a word repeated, a double tap - finds nothing armed rather than recording
    // a second dose.
    const second = reduce(first.session, { kind: 'CONFIRM', proposalId: 'p1', at: T0 + 2_000 });
    expect(second.released).toBeNull();
    expect(second.refusal).toBe('NOTHING_TO_CONFIRM');
  });

  it('refuses a confirmation naming a different proposal, and disarms', () => {
    // The two sides disagree about what is on the table. The safe reading of that is neither.
    const outcome = reduce(armed('p1'), { kind: 'CONFIRM', proposalId: 'p2', at: T0 + 1_000 });
    expect(outcome.released).toBeNull();
    expect(outcome.refusal).toBe('WRONG_PROPOSAL');
    expect(outcome.session.pending).toBeNull();
  });

  it('refuses a confirmation that arrives too late', () => {
    // A phone left on a table must not be holding a live "yes" for a medicine record.
    const outcome = reduce(armed(), {
      kind: 'CONFIRM',
      proposalId: 'p1',
      at: T0 + CONFIRMATION_WINDOW_MS + 1,
    });
    expect(outcome.released).toBeNull();
    expect(outcome.refusal).toBe('CONFIRMATION_EXPIRED');
    expect(outcome.session.pending).toBeNull();
  });

  it('accepts one that arrives at the last moment', () => {
    const outcome = reduce(armed(), {
      kind: 'CONFIRM',
      proposalId: 'p1',
      at: T0 + CONFIRMATION_WINDOW_MS,
    });
    expect(outcome.released?.id).toBe('p1');
  });

  it('refuses a confirmation when nothing was proposed at all', () => {
    const outcome = reduce(emptySession(null), { kind: 'CONFIRM', proposalId: 'p1', at: T0 });
    expect(outcome.refusal).toBe('NOTHING_TO_CONFIRM');
    expect(outcome.released).toBeNull();
  });
});

describe('changing the subject', () => {
  it('disarms when the person starts talking again', () => {
    // The failure this prevents: somebody asks something else, the old proposal is still armed,
    // and the word "yes" in their next sentence lands on it.
    const outcome = reduce(armed(), { kind: 'START_LISTENING' });
    expect(outcome.session.pending).toBeNull();
    expect(outcome.session.state).toBe('LISTENING');
  });

  it('disarms on an explicit cancel', () => {
    const outcome = reduce(armed(), { kind: 'CANCEL' });
    expect(outcome.session.pending).toBeNull();
    expect(outcome.session.state).toBe('IDLE');
  });

  it('keeps the proposal armed while Kynviora is still speaking about it', () => {
    // The summary and a follow-up sentence about it are one turn. Disarming between them would
    // make the phrase "shall I do that?" cancel the thing it is asking about.
    const outcome = reduce(armed(), {
      kind: 'SAY',
      text: 'Shall I do that? Say yes, or press the large button.',
      at: T0 + 10,
      id: 's1',
      spoken: true,
    });
    expect(outcome.session.pending?.id).toBe('p1');
    expect(outcome.session.state).toBe('AWAITING_CONFIRMATION');
  });

  it('does not lose the armed proposal when the microphone closes', () => {
    // Somebody who pressed the button to stop listening, so they could think, has not cancelled.
    const stopped = reduce(armed(), { kind: 'STOP_LISTENING' });
    expect(stopped.session.state).toBe('AWAITING_CONFIRMATION');
    expect(stopped.session.pending?.id).toBe('p1');
  });
});

describe('the transcript', () => {
  it('records both sides, in order, with the time each was said', () => {
    let session = emptySession('profile-1');
    session = reduce(session, {
      kind: 'HEARD',
      text: 'what medicines am I taking',
      at: T0,
      id: 'h1',
    }).session;
    session = reduce(session, {
      kind: 'SAY',
      text: 'Two medicines are recorded.',
      at: T0 + 500,
      id: 's1',
      spoken: true,
    }).session;

    expect(session.transcript.map((entry) => entry.speaker)).toEqual(['PERSON', 'KYNVIORA']);
    expect(session.transcript[0]?.text).toBe('what medicines am I taking');
    expect(session.transcript[1]?.at).toBe(T0 + 500);
  });

  it('says which lines were spoken aloud and which were only shown', () => {
    // Different events for somebody not looking at the screen. A refusal that was shown and not
    // spoken is one they have no way to know about.
    let session = emptySession(null);
    session = reduce(session, {
      kind: 'SAY',
      text: 'Done.',
      at: T0,
      id: 's1',
      spoken: false,
    }).session;
    expect(session.transcript[0]?.spoken).toBe(false);
  });

  it('survives the conversation ending', () => {
    // The transcript is the accessible record of what was said and done. Somebody who missed a
    // sentence has to be able to read it back after the microphone closes.
    let session = reduce(emptySession(null), {
      kind: 'SAY',
      text: 'Done.',
      at: T0,
      id: 's1',
      spoken: true,
    }).session;
    session = reduce(session, { kind: 'END' }).session;
    expect(session.transcript).toHaveLength(1);
    expect(session.state).toBe('IDLE');
  });
});

describe('proposalIsLive', () => {
  it('is true inside the window and false outside it', () => {
    const p = proposal('p1');
    expect(proposalIsLive(p, T0)).toBe(true);
    expect(proposalIsLive(p, T0 + CONFIRMATION_WINDOW_MS)).toBe(true);
    expect(proposalIsLive(p, T0 + CONFIRMATION_WINDOW_MS + 1)).toBe(false);
  });

  it('reads the clock it is given rather than the device', () => {
    // The device's own clock is moved by two device harnesses and by anybody who wants to. A
    // confirmation window measured against it is a window somebody can widen.
    const p = proposal('p1', 0);
    expect(proposalIsLive(p, CONFIRMATION_WINDOW_MS - 1)).toBe(true);
  });
});
