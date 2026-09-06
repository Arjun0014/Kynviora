/**
 * What an agent cannot get past, including when it is trying to.
 *
 * Spec references: `17` (a model's proposal is checked, never trusted; models get no write
 * tools), `13`, `14`, `11`, `15` (model output is untrusted input), `12`. DEC-132.
 *
 * The tests that matter here are the refusals, and they are written from the attacker's side: a
 * proposal that names a forbidden tool, one that invents an argument, one that arrives without
 * the confirmation, and one that arrives while the person's grant has just been revoked.
 */

import { describe, it, expect, vi } from 'vitest';
import { checkCall, dispatch, type DispatchContext, type ToolExecutor } from './dispatcher.js';
import { toolNamed } from './registry.js';
import type { ToolCapability } from './tools.js';

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

/**
 * An executor that records what it was asked to do and answers trivially.
 *
 * The record is beside the executor rather than a property of it: `ToolExecutor` is indexed by
 * tool name, so a `calls` key on the same object would be a tool named `calls`.
 */
function recordingExecutor(): { readonly executor: ToolExecutor; readonly calls: string[] } {
  const calls: string[] = [];
  const run = (name: string) => () => {
    calls.push(name);
    return Promise.resolve({ ran: name });
  };
  return {
    calls,
    executor: {
      list_medicines: run('list_medicines'),
      record_dose: run('record_dose'),
      open_screen: run('open_screen'),
      delete_account: run('delete_account'),
      prepare_visit_pack: run('prepare_visit_pack'),
      delete_item: run('delete_item'),
      invite_caregiver: run('invite_caregiver'),
    },
  };
}

describe('a name nobody defined', () => {
  it('is refused before anything else is looked at', async () => {
    // A model asked to double a dose will propose one. There is no tool for it, so the proposal
    // dies at the first gate rather than at a policy check somebody has to remember to write.
    const outcome = await dispatch(
      { name: 'change_dose', arguments: { itemId: 'i1', multiplier: 2 } },
      context({ confirmed: true }),
      recordingExecutor().executor,
    );
    expect(outcome.kind).toBe('REFUSED');
    if (outcome.kind === 'REFUSED') {
      expect(outcome.refusal).toBe('UNKNOWN_TOOL');
      expect(outcome.tool).toBeNull();
    }
  });

  it('cannot be reached by an executor key that happens to exist', async () => {
    // The executor is a plain object, so a name matching one of its keys must still not run.
    // The lookup goes through the registry first; the executor is consulted last and only for a
    // tool that has already passed six gates.
    const recording = recordingExecutor();
    await dispatch(
      { name: 'toString', arguments: {} },
      context({ confirmed: true }),
      recording.executor,
    );
    await dispatch(
      { name: 'constructor', arguments: {} },
      context({ confirmed: true }),
      recording.executor,
    );
    expect(recording.calls).toEqual([]);
  });
});

describe('what voice may not reach', () => {
  it('refuses a touch-only tool proposed by voice, and does not run it', async () => {
    const recording = recordingExecutor();
    const outcome = await dispatch(
      { name: 'delete_account', arguments: {} },
      context({ origin: 'VOICE', confirmed: true, stepUpFresh: true }),
      recording.executor,
    );
    expect(outcome.kind).toBe('REFUSED');
    if (outcome.kind === 'REFUSED') expect(outcome.refusal).toBe('NOT_PERMITTED_BY_VOICE');
    expect(recording.calls).toEqual([]);
  });

  it('refuses it even with everything else in its favour', async () => {
    // Owner, fresh identity, online, confirmed. The voice gate is not one of several conditions
    // that can be traded against each other.
    for (const name of ['prepare_visit_pack', 'invite_caregiver', 'delete_item'] as const) {
      const recording = recordingExecutor();
      const outcome = await dispatch(
        { name, arguments: { profileId: 'p1', itemId: 'i1', grantId: 'g1' } },
        context({ origin: 'VOICE', confirmed: true, stepUpFresh: true, isOwner: true }),
        recording.executor,
      );
      expect(outcome.kind).toBe('REFUSED');
      expect(recording.calls).toEqual([]);
    }
  });

  it('refuses before it inspects the arguments', () => {
    // Otherwise a caller could learn what arguments a forbidden tool takes by watching which ones
    // come back as invalid, which is an enumeration oracle over the tool surface.
    const outcome = checkCall(
      { name: 'delete_account', arguments: { nonsense: 1 } },
      context({ origin: 'VOICE' }),
    );
    expect(outcome.kind).toBe('REFUSED');
    if (outcome.kind === 'REFUSED') expect(outcome.refusal).toBe('NOT_PERMITTED_BY_VOICE');
  });

  it('lets touch reach it, because touch is where it lives', () => {
    // `TOUCH_ONLY` is about the channel, not about the capability. The same registry serves both,
    // so a screen calling through it gets the same six gates.
    const outcome = checkCall(
      { name: 'delete_account', arguments: {} },
      context({ origin: 'TOUCH', stepUpFresh: true }),
    );
    expect(outcome.kind).toBe('OK');
  });
});

describe('arguments a model invented', () => {
  it('refuses an undeclared argument rather than dropping it', async () => {
    // Dropping it silently would be the worse failure: the call would run, having been described
    // to the person by a summary that also dropped it.
    const recording = recordingExecutor();
    const outcome = await dispatch(
      { name: 'list_medicines', arguments: { profileId: 'p1', includeOtherHouseholds: true } },
      context(),
      recording.executor,
    );
    expect(outcome.kind).toBe('REFUSED');
    if (outcome.kind === 'REFUSED') {
      expect(outcome.refusal).toBe('UNEXPECTED_ARGUMENT');
      expect(outcome.parameter).toBe('includeOtherHouseholds');
    }
    expect(recording.calls).toEqual([]);
  });

  it('refuses an enum value nobody listed', async () => {
    const outcome = await dispatch(
      { name: 'record_dose', arguments: { itemId: 'i1', eventKind: 'DOUBLED' } },
      context({ confirmed: true }),
      recordingExecutor().executor,
    );
    expect(outcome.kind).toBe('REFUSED');
    if (outcome.kind === 'REFUSED') expect(outcome.refusal).toBe('INVALID_ARGUMENTS');
  });
});

describe('capability', () => {
  it('refuses a dose from somebody the server has not granted `RECORD_DOSES`', async () => {
    // DEC-116: no existing grant acquired it, and `VIEW_MEDICINES` is not a way in. This stops the
    // agent offering it; the route refuses it regardless, which is where the decision lives.
    const recording = recordingExecutor();
    const outcome = await dispatch(
      { name: 'record_dose', arguments: { itemId: 'i1', eventKind: 'TAKEN' } },
      context({ capabilities: new Set<ToolCapability>(['VIEW_MEDICINES']), confirmed: true }),
      recording.executor,
    );
    expect(outcome.kind).toBe('REFUSED');
    if (outcome.kind === 'REFUSED') expect(outcome.refusal).toBe('CAPABILITY_MISSING');
    expect(recording.calls).toEqual([]);
  });

  it('does not let a capability set satisfy ownership', () => {
    // `OWNER_ONLY` is the absence of every caregiver path, not a capability. Answering it from
    // the set would let a future capability of that name satisfy it - which is the shape of
    // mistake DEC-116 was about.
    const outcome = checkCall(
      { name: 'delete_item', arguments: { itemId: 'i1' } },
      context({
        origin: 'TOUCH',
        isOwner: false,
        capabilities: new Set<ToolCapability>(['OWNER_ONLY', 'MANAGE_MEDICINES']),
      }),
    );
    expect(outcome.kind).toBe('REFUSED');
    if (outcome.kind === 'REFUSED') expect(outcome.refusal).toBe('CAPABILITY_MISSING');
  });
});

describe('identity, network and confirmation', () => {
  it('refuses a step-up tool on a session that has not confirmed identity', () => {
    const outcome = checkCall(
      { name: 'export_my_data', arguments: {} },
      context({ origin: 'TOUCH', stepUpFresh: false }),
    );
    expect(outcome.kind).toBe('REFUSED');
    if (outcome.kind === 'REFUSED') expect(outcome.refusal).toBe('STEP_UP_REQUIRED');
  });

  it('refuses an online-only tool with no network, and says which', () => {
    const outcome = checkCall(
      { name: 'add_medicine', arguments: { profileId: 'p1', displayName: 'Tablet A' } },
      context({ online: false }),
    );
    expect(outcome.kind).toBe('REFUSED');
    if (outcome.kind === 'REFUSED') expect(outcome.refusal).toBe('OFFLINE');
  });

  it('lets a dose through with no network, because the journal takes it', () => {
    // `03` group J and DEC-111. The queue is the one write a phone can make with no signal.
    const outcome = checkCall(
      { name: 'record_dose', arguments: { itemId: 'i1', eventKind: 'TAKEN' } },
      context({ online: false }),
    );
    expect(outcome.kind).toBe('OK');
  });

  it('refuses a write nobody confirmed, and runs it once they have', async () => {
    const recording = recordingExecutor();
    const call = { name: 'record_dose', arguments: { itemId: 'i1', eventKind: 'TAKEN' } };

    const refused = await dispatch(call, context({ confirmed: false }), recording.executor);
    expect(refused.kind).toBe('REFUSED');
    if (refused.kind === 'REFUSED') expect(refused.refusal).toBe('CONFIRMATION_REQUIRED');
    expect(recording.calls).toEqual([]);

    const ran = await dispatch(call, context({ confirmed: true }), recording.executor);
    expect(ran.kind).toBe('OK');
    expect(recording.calls).toEqual(['record_dose']);
  });

  it('re-checks at execution time rather than trusting an earlier check', async () => {
    // The two are separated by a person deciding something, which takes seconds - during which a
    // session expires, a network drops, or a grant is revoked. `CAR-4` is the device scenario for
    // the last of those: the caregiver's very next request returns nothing.
    const call = { name: 'record_dose', arguments: { itemId: 'i1', eventKind: 'TAKEN' } };
    expect(checkCall(call, context()).kind).toBe('OK');

    const recording = recordingExecutor();
    const outcome = await dispatch(
      call,
      context({ confirmed: true, capabilities: new Set<ToolCapability>(['VIEW_MEDICINES']) }),
      recording.executor,
    );
    expect(outcome.kind).toBe('REFUSED');
    expect(recording.calls).toEqual([]);
  });
});

describe('what has no provider', () => {
  it('refuses an extraction tool and names the blocker', async () => {
    const outcome = await dispatch(
      { name: 'read_extracted_fields', arguments: {} },
      context(),
      recordingExecutor().executor,
    );
    expect(outcome.kind).toBe('REFUSED');
    if (outcome.kind === 'REFUSED') {
      expect(outcome.refusal).toBe('BLOCKED');
      expect(outcome.blocker).toBe('BLK-007');
    }
  });

  it('refuses a tool with no executor rather than throwing', async () => {
    // A partial executor is normal: the app wires the tools it has. A missing one is the same
    // answer as a blocked one, and never a crash inside a conversation.
    const outcome = await dispatch({ name: 'list_pending_changes', arguments: {} }, context(), {});
    expect(outcome.kind).toBe('REFUSED');
    if (outcome.kind === 'REFUSED') expect(outcome.refusal).toBe('BLOCKED');
  });
});

describe('the executor is the app, and nothing else', () => {
  it('passes the whole call through, unmodified', async () => {
    // The dispatcher validates and then hands over. It does not rewrite arguments, which would be
    // a second thing composing what happens and a place for the two to disagree.
    const seen: unknown[] = [];
    const outcome = await dispatch(
      { name: 'record_dose', arguments: { itemId: 'i1', eventKind: 'SKIPPED', note: 'felt off' } },
      context({ confirmed: true }),
      {
        record_dose: (call) => {
          seen.push(call);
          return Promise.resolve('done');
        },
      },
    );
    expect(outcome.kind).toBe('OK');
    expect(seen).toEqual([
      { name: 'record_dose', arguments: { itemId: 'i1', eventKind: 'SKIPPED', note: 'felt off' } },
    ]);
  });

  it('is never called for a refused proposal, whatever the reason', async () => {
    // The single property this whole file is about: an agent's reach is the app's reach, and a
    // refused proposal reaches nothing at all.
    const run = vi.fn(() => Promise.resolve(null));
    const neverRuns: ToolExecutor = {
      delete_account: run,
      record_dose: run,
      list_medicines: run,
      add_medicine: run,
      export_my_data: run,
    };
    const refusals = [
      { call: { name: 'delete_account', arguments: {} }, ctx: context({ confirmed: true }) },
      {
        call: { name: 'record_dose', arguments: { itemId: 'i1', eventKind: 'TAKEN' } },
        ctx: context({ confirmed: false }),
      },
      {
        call: { name: 'list_medicines', arguments: { profileId: 'p1', extra: 1 } },
        ctx: context(),
      },
      {
        call: { name: 'add_medicine', arguments: { profileId: 'p1', displayName: 'x' } },
        ctx: context({ confirmed: true, online: false }),
      },
      {
        call: { name: 'export_my_data', arguments: {} },
        ctx: context({ origin: 'TOUCH', confirmed: true, stepUpFresh: false }),
      },
    ];
    for (const { call, ctx } of refusals) {
      const outcome = await dispatch(call, ctx, neverRuns);
      expect(outcome.kind).toBe('REFUSED');
    }
    expect(run).not.toHaveBeenCalled();
  });
});

describe('every tool is reachable by some legitimate caller', () => {
  it('has no tool that nothing could ever satisfy', () => {
    // A guard against a registry entry that is refused by construction - a `TOUCH_ONLY` tool
    // nobody can call from touch either, which would be a control that exists and does nothing.
    for (const name of ['delete_account', 'record_dose', 'list_medicines'] as const) {
      const tool = toolNamed(name);
      expect(tool).not.toBeNull();
      const outcome = checkCall(
        { name, arguments: sampleFor(name) },
        context({
          origin: tool?.voice === 'ALLOWED' ? 'VOICE' : 'TOUCH',
          stepUpFresh: true,
          isOwner: true,
        }),
      );
      expect(outcome.kind).toBe('OK');
    }
  });
});

function sampleFor(name: string): Record<string, unknown> {
  if (name === 'record_dose') return { itemId: 'i1', eventKind: 'TAKEN' };
  if (name === 'list_medicines') return { profileId: 'p1' };
  return {};
}
