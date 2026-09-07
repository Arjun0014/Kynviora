/**
 * The whole pipeline, driven by a fake agent, in Node, with no microphone.
 *
 * Spec references: `19` (deterministic fixtures), `17`, `14`, `13`, `12`. DEC-132 to DEC-136.
 *
 * WHAT THIS ESTABLISHES
 * That a proposal travels from an agent, through the six gates, into a confirmation a person
 * agreed to the wording of, into the app's own executor, and back out as words that passed the
 * Speech Gate - and that every refusal along the way ends somewhere a person can act on.
 *
 * WHAT IT DOES NOT ESTABLISH
 * That a real model would propose the right tool for a real sentence. That is the interesting and
 * unmeasured half, and it is unmeasured because there is no provider (`BLK-012`) rather than
 * because nobody looked.
 */

import { describe, it, expect } from 'vitest';
import { createScriptedAgent, demonstrationScript, type ScriptedRule } from './scriptedAgent.js';
import { checkCall, dispatch, type DispatchContext, type ToolExecutor } from './dispatcher.js';
import { emptySession, reduce, type PendingProposal, type VoiceSession } from './session.js';
import { gateSpeech, UTTERANCES, type SpeechPart } from './speech.js';
import { summariseProposal, utteranceForRefusal } from './summary.js';
import type { AgentTurn } from './ports.js';
import type { ToolCapability } from './tools.js';

const PROFILE = 'profile-under-test';
const ITEM = 'item-under-test';
const T0 = 1_760_000_000_000;

const AGENT = createScriptedAgent(demonstrationScript(PROFILE, ITEM));

function context(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    capabilities: new Set<ToolCapability>([
      'VIEW_MEDICINES',
      'VIEW_PERSONAL_CARE',
      'RECORD_DOSES',
      'MANAGE_MEDICINES',
      'MANAGE_PERSONAL_CARE',
      'VIEW_ALERTS',
    ]),
    isOwner: true,
    stepUpFresh: false,
    online: true,
    origin: 'VOICE',
    confirmed: false,
    ...overrides,
  };
}

/** What the app's executor would return, composed by the presentation layer in the real thing. */
const SHELF_LINE = 'Two medicines are recorded for Anita.';
const DOSE_LINE = 'Recorded.';

function executor(recorded: string[]): ToolExecutor {
  return {
    list_medicines: () => {
      recorded.push('list_medicines');
      return Promise.resolve({ spoken: [SHELF_LINE] });
    },
    record_dose: () => {
      recorded.push('record_dose');
      return Promise.resolve({ spoken: [DOSE_LINE] });
    },
    open_screen: () => {
      recorded.push('open_screen');
      return Promise.resolve({ spoken: [] });
    },
    start_package_capture: () => {
      recorded.push('start_package_capture');
      return Promise.resolve({ spoken: [] });
    },
  };
}

/**
 * One turn: hear something, ask the agent, and take the proposal as far as it goes without a
 * confirmation. Returns what would be said and what state the conversation is in.
 */
async function turn(
  session: VoiceSession,
  said: string,
  ctx: DispatchContext,
  recorded: string[],
): Promise<{
  readonly session: VoiceSession;
  readonly spoken: string | null;
  readonly proposal: PendingProposal | null;
  readonly ran: readonly string[];
}> {
  let next = reduce(session, { kind: 'HEARD', text: said, at: T0, id: `h-${said}` }).session;

  const proposed: AgentTurn = await AGENT.proposeTurn({
    said,
    history: next.transcript.map((entry) => entry.text),
    // The agent is told only what it may call. A `TOUCH_ONLY` tool is not in this list.
    tools: [],
  });

  if (proposed.kind === 'SAY') {
    const key = proposed.utterance as keyof typeof UTTERANCES;
    const gated = gateSpeech([{ kind: 'UTTERANCE', key }], []);
    const text = gated.ok ? gated.text : UTTERANCES.notUnderstood;
    next = reduce(next, { kind: 'SAY', text, at: T0 + 1, id: `s-${said}`, spoken: true }).session;
    return { session: next, spoken: text, proposal: null, ran: recorded };
  }

  if (proposed.kind !== 'CALL') {
    return { session: next, spoken: null, proposal: null, ran: recorded };
  }

  const call = { name: proposed.name, arguments: proposed.arguments };
  const checked = checkCall(call, ctx);

  if (checked.kind === 'REFUSED') {
    const gated = gateSpeech(
      [{ kind: 'UTTERANCE', key: utteranceForRefusal(checked.refusal) }],
      [],
    );
    const text = gated.ok ? gated.text : UTTERANCES.cannotDoThat;
    next = reduce(next, { kind: 'SAY', text, at: T0 + 1, id: `r-${said}`, spoken: true }).session;
    return { session: next, spoken: text, proposal: null, ran: recorded };
  }

  if (checked.tool.confirmation === 'EXPLICIT') {
    const proposal: PendingProposal = {
      id: `proposal-${said}`,
      call,
      tool: checked.tool,
      summary: summariseProposal(checked.tool, call, 'Tablet A'),
      armedAt: T0,
    };
    next = reduce(next, { kind: 'PROPOSE', proposal }).session;
    next = reduce(next, {
      kind: 'SAY',
      text: `${proposal.summary} ${UTTERANCES.confirmPrompt}`,
      at: T0 + 1,
      id: `c-${said}`,
      spoken: true,
    }).session;
    return { session: next, spoken: proposal.summary, proposal, ran: recorded };
  }

  const outcome = await dispatch(call, ctx, executor(recorded));
  const lines =
    outcome.kind === 'OK' ? ((outcome.value as { spoken?: string[] }).spoken ?? []) : [];
  const parts: SpeechPart[] =
    lines.length === 0
      ? [{ kind: 'UTTERANCE', key: 'done' }]
      : lines.map((line) => ({ kind: 'COMPOSED', text: line }));
  const gated = gateSpeech(parts, lines);
  const text = gated.ok ? gated.text : UTTERANCES.cannotDoThat;
  next = reduce(next, { kind: 'SAY', text, at: T0 + 2, id: `d-${said}`, spoken: true }).session;
  return { session: next, spoken: text, proposal: null, ran: recorded };
}

describe('"what medicines am I taking?"', () => {
  it('reads back what the app composed, and nothing else', async () => {
    const recorded: string[] = [];
    const result = await turn(
      emptySession(PROFILE),
      'What medicines am I taking',
      context(),
      recorded,
    );
    expect(recorded).toEqual(['list_medicines']);
    expect(result.spoken).toBe(SHELF_LINE);
    // No confirmation for a read. Asking permission to read something out is noise, and noise is
    // what teaches somebody to confirm without listening.
    expect(result.proposal).toBeNull();
  });
});

describe('recording a dose', () => {
  it('describes what it will do, waits, and only then writes', async () => {
    const recorded: string[] = [];
    const proposed = await turn(emptySession(PROFILE), 'I took it', context(), recorded);

    expect(recorded).toEqual([]);
    expect(proposed.proposal).not.toBeNull();
    expect(proposed.spoken).toContain('took it');
    expect(proposed.session.state).toBe('AWAITING_CONFIRMATION');

    const confirmed = reduce(proposed.session, {
      kind: 'CONFIRM',
      proposalId: proposed.proposal?.id ?? '',
      at: T0 + 5_000,
    });
    expect(confirmed.released).not.toBeNull();

    const outcome = await dispatch(
      confirmed.released?.call ?? { name: '', arguments: {} },
      context({ confirmed: true }),
      executor(recorded),
    );
    expect(outcome.kind).toBe('OK');
    expect(recorded).toEqual(['record_dose']);
  });

  it('says the right thing for a skip, which is one word away from the wrong thing', async () => {
    // "shall I record that you took it" and "shall I record that you skipped it" are one word
    // apart and both fluent. This is why the summary is composed by this repository.
    const taken = await turn(emptySession(PROFILE), 'I took it', context(), []);
    const skipped = await turn(emptySession(PROFILE), 'I skipped it', context(), []);
    expect(taken.spoken).toContain('took it');
    expect(skipped.spoken).toContain('skipped it');
    expect(taken.spoken).not.toBe(skipped.spoken);
  });

  it('writes nothing when the person says no', async () => {
    const recorded: string[] = [];
    const proposed = await turn(emptySession(PROFILE), 'I took it', context(), recorded);
    const cancelled = reduce(proposed.session, { kind: 'CANCEL' });
    expect(cancelled.session.pending).toBeNull();
    expect(recorded).toEqual([]);
  });
});

describe('what it refuses, and what it says instead', () => {
  it('will not close an account by voice, and points at the screen', async () => {
    const recorded: string[] = [];
    const result = await turn(emptySession(PROFILE), 'Delete my account', context(), recorded);
    expect(recorded).toEqual([]);
    expect(result.spoken).toBe(UTTERANCES.touchOnly);
  });

  it('will not give somebody access by voice, and says identity has to be confirmed', async () => {
    // `invite_caregiver` is refused for the voice channel before step-up is ever consulted, so
    // the sentence is about the screen. Both are true and the first is the one that helps.
    const result = await turn(emptySession(PROFILE), 'Give my daughter access', context(), []);
    expect(result.spoken).toBe(UTTERANCES.touchOnly);
  });

  it('will not remove a medicine by voice', async () => {
    const recorded: string[] = [];
    const result = await turn(emptySession(PROFILE), 'Remove that medicine', context(), recorded);
    expect(recorded).toEqual([]);
    expect(result.spoken).toBe(UTTERANCES.touchOnly);
  });

  it('has no way to double a dose, so the proposal dies at the first gate', async () => {
    // The agent proposes it - a real model asked this will too. There is no tool of that name, so
    // it is an unknown-tool refusal rather than a policy check somebody had to remember to write.
    const recorded: string[] = [];
    const result = await turn(emptySession(PROFILE), 'Double my dose', context(), recorded);
    expect(recorded).toEqual([]);
    expect(result.spoken).toBe(UTTERANCES.cannotDoThat);
  });

  it('refuses an argument the agent invented', async () => {
    const recorded: string[] = [];
    const result = await turn(
      emptySession(PROFILE),
      'Show me everything for everyone',
      context(),
      recorded,
    );
    expect(recorded).toEqual([]);
    expect(result.spoken).toBe(UTTERANCES.cannotDoThat);
  });

  it('answers "is it safe" with the one sentence that exists for it', async () => {
    const result = await turn(emptySession(PROFILE), 'Is it safe', context(), []);
    expect(result.spoken).toBe(UTTERANCES.notMedicalAdvice);
  });

  it('says the label cannot be read, and names nothing it did not read', async () => {
    // `BLK-007`. Inventing a field here is the exact failure `17` exists to prevent, and the
    // honest answer is that the capability is unfinished.
    const recorded: string[] = [];
    const result = await turn(emptySession(PROFILE), 'What does the box say', context(), recorded);
    expect(recorded).toEqual([]);
    expect(result.spoken).toBe(UTTERANCES.blocked);
  });
});

describe('offline', () => {
  it('still records a dose, because the journal takes it', async () => {
    const recorded: string[] = [];
    const proposed = await turn(
      emptySession(PROFILE),
      'I took it',
      context({ online: false }),
      recorded,
    );
    expect(proposed.proposal).not.toBeNull();
  });

  it('says so rather than failing quietly for anything that needs the server', async () => {
    const result = await turn(
      emptySession(PROFILE),
      'Photograph the box',
      context({ online: false }),
      [],
    );
    expect(result.spoken).toBe(UTTERANCES.offline);
  });
});

describe('navigation', () => {
  it('opens a destination with no confirmation and no writing', async () => {
    const recorded: string[] = [];
    const result = await turn(emptySession(PROFILE), 'Open the shelf', context(), recorded);
    expect(recorded).toEqual(['open_screen']);
    expect(result.proposal).toBeNull();
  });
});

describe('the camera', () => {
  it('asks before opening it, even though it writes nothing', async () => {
    // `16` treats a capture as a deliberate act: pointing a lens at somebody's home on a misheard
    // word is worth one question.
    const recorded: string[] = [];
    const result = await turn(emptySession(PROFILE), 'Photograph the box', context(), recorded);
    expect(recorded).toEqual([]);
    expect(result.proposal?.tool.name).toBe('start_package_capture');
    expect(result.spoken).toContain('front of the pack');
  });
});

describe('the transcript', () => {
  it('holds every word of an exchange, in order, on both sides', async () => {
    const first = await turn(emptySession(PROFILE), 'What medicines am I taking', context(), []);
    const second = await turn(first.session, 'Open the shelf', context(), []);
    expect(second.session.transcript.map((entry) => entry.speaker)).toEqual([
      'PERSON',
      'KYNVIORA',
      'PERSON',
      'KYNVIORA',
    ]);
    expect(second.session.transcript[1]?.text).toBe(SHELF_LINE);
  });
});

/**
 * The identifiers the demonstration script needs, and what it does without them.
 *
 * Spec references: `19` (a device scenario measures what only a device can show), `17`, DEC-136,
 * `DEV-073`, `DEV-095`.
 *
 * WHY THIS IS WORTH A TEST IN A FILE ABOUT A FAKE
 * The script is a development affordance and its failure mode was not. `resolveVoiceProviders`
 * passed `null` for the item, `demonstrationScript` turned that into `''`, and `validateArguments`
 * refuses an empty required string - so every item-scoped rule was refused as `INVALID_ARGUMENTS`
 * and the shell spoke "I cannot do that by voice."
 *
 * That is a sentence about a capability, said about a capability that works. A device harness
 * reading it cannot tell a refused proposal from a malformed one, and none of
 * `verify:device:voice`'s nine checks drives an item-scoped tool that has to succeed - so nothing
 * noticed until a run tried to set a reminder and was told voice could not (`DEV-095`).
 */
describe('a script with identifiers it does not have', () => {
  const named = (rules: readonly ScriptedRule[]): readonly string[] =>
    rules.flatMap((rule) => (rule.then.kind === 'CALL' ? [rule.then.name] : []));

  it('leaves out every rule whose identifier is missing, rather than emitting an empty one', () => {
    const withoutItem = named(demonstrationScript(PROFILE, null));
    // The four that need one. `delete_item` is `TOUCH_ONLY` and would be refused a gate earlier,
    // which is exactly why it must not be here either: a refusal for the wrong reason reads as the
    // right one.
    for (const name of [
      'explain_what_is_missing',
      'record_dose',
      'create_schedule',
      'delete_item',
    ]) {
      expect(withoutItem, `${name} was offered with no item`).not.toContain(name);
    }
    // And the profile-scoped ones are untouched, so this is a filter rather than a collapse.
    expect(withoutItem).toContain('list_medicines');
    expect(withoutItem).toContain('start_package_capture');
  });

  it('leaves out the profile-scoped rules when there is no profile', () => {
    const withoutProfile = named(demonstrationScript(null, ITEM));
    expect(withoutProfile).not.toContain('list_medicines');
    expect(withoutProfile).not.toContain('start_package_capture');
    expect(withoutProfile).toContain('record_dose');
  });

  it('never emits an empty string argument, whatever it was given', () => {
    // The property rather than the list: a rule added later with a new identifier is covered.
    for (const [profile, item] of [
      [PROFILE, ITEM],
      [PROFILE, null],
      [null, ITEM],
      [null, null],
    ] as const) {
      for (const rule of demonstrationScript(profile, item)) {
        if (rule.then.kind !== 'CALL') continue;
        for (const [key, value] of Object.entries(rule.then.arguments)) {
          expect(
            typeof value === 'string' ? value.trim() : 'ok',
            `${rule.then.name}.${key}`,
          ).not.toBe('');
        }
      }
    }
  });

  it('keeps the answers, which need no identifier at all', () => {
    // `yes` and `no` are how a confirmation is released, so a script stripped of everything else
    // must still be able to answer one.
    const bare = demonstrationScript(null, null);
    expect(bare.some((rule) => rule.then.kind === 'CONFIRM')).toBe(true);
    expect(bare.some((rule) => rule.then.kind === 'CANCEL')).toBe(true);
  });
});
