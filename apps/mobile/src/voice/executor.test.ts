/**
 * What the registry offers, against what the executor can actually do.
 *
 * Spec references: `17`, `docs/design/VOICE_MODE.md` sections 3 and 4, DEC-136, DEC-141.
 *
 * WHY THIS TEST EXISTS
 * `docs/design/VOICE_MODE.md` states the property the whole layer rests on: "the agent's reach is
 * the app's reach". The registry is what the agent is **told** it may call - `voiceCallableTools`
 * is literally the list handed to a provider - and the executor is what can actually run. Nothing
 * compared the two.
 *
 * They disagree. Six tools are `voice: 'ALLOWED'` with `blockedBy: null` and have no executor
 * entry, so `dispatch` refuses them at its last step with `BLOCKED` and **no blocker identifier**,
 * and the person hears "that part of Kynviora is not finished yet" for a capability the registry
 * and the design document both present as available. `list_safety_state` is the one that matters
 * most: "is there anything I should know about my medicines" is one of the journeys Voice Mode
 * exists for.
 *
 * It fails safe - a refusal, never a wrong action - and it is not a capability gap either: the
 * `KynvioraClient` already has `profileAlerts`, `alertDetail`, `listCaregiverGrants`, `updateItem`
 * and `updateSchedule`. They were never wired.
 *
 * WHY AN ALLOWLIST RATHER THAN A FAILING TEST
 * Wiring six tools - two of them writes, which need a summary, a confirmation and a decision about
 * the offline journal - is a feature, and a feature needs device verification before it is claimed.
 * Recorded as `DEV-084` and listed here instead, so the gap is **visible, counted, and cannot
 * grow**: a new tool added as callable-and-unwired fails this test on the day it is added.
 */

import { describe, it, expect } from 'vitest';
import { allTools, voiceCallableTools } from '@kynviora/agent';
import { createToolExecutor, type ToolResult, type VoiceBridge } from './executor';
import type { KynvioraClient } from '@kynviora/contracts';
import type { ToolCall, ToolExecutor } from '@kynviora/agent';

/**
 * Run one tool and read its answer as the executor's own result type.
 *
 * `ToolExecutor` is declared as returning `Promise<unknown>` on purpose - the dispatcher does not
 * care what a tool answers - so the narrowing happens once, here, rather than at every assertion.
 */
async function resultOf(
  executor: ToolExecutor,
  tool: string,
  call: ToolCall,
): Promise<ToolResult | undefined> {
  return (await executor[tool]?.(call)) as ToolResult | undefined;
}

/**
 * The tools known to be offered and unwired, on 2026-09-07.
 *
 * Every entry here is a claim Voice Mode makes and cannot honour. Shrinking this list is the work;
 * adding to it needs a reason written down beside it.
 */
const KNOWN_UNWIRED = [
  'describe_alert',
  'list_caregiver_access',
  'list_pending_changes',
  'list_safety_state',
  'update_item',
  'update_schedule',
] as const;

/**
 * A client and a bridge that do nothing.
 *
 * The executor is built rather than mocked because the question is which **keys** it defines, and
 * a hand-written list of keys would be a second copy of the thing under test.
 */
function executorKeys(): ReadonlySet<string> {
  const client = {} as KynvioraClient;
  const bridge = {} as VoiceBridge;
  const executor = createToolExecutor(client, bridge, () => Promise.resolve(false));
  return new Set(Object.keys(executor));
}

describe('the registry and the executor agree about what voice can do', () => {
  const wired = executorKeys();

  /**
   * The list a provider is handed. A `TOUCH_ONLY` tool is not in it by construction, so anything
   * here is something the agent may genuinely propose.
   */
  const offered = voiceCallableTools().filter((tool) => tool.blockedBy === null);

  it('every offered, unblocked tool is either wired or a known gap', () => {
    const missing = offered
      .map((tool) => tool.name)
      .filter((name) => !wired.has(name))
      .filter((name) => !(KNOWN_UNWIRED as readonly string[]).includes(name));
    expect(missing).toEqual([]);
  });

  /**
   * The other direction, and the one that keeps the allowlist honest: a tool that has been wired
   * must be taken off the list. Without this, `KNOWN_UNWIRED` would quietly become a list of
   * things that used to be broken.
   */
  it('nothing on the known-gap list has quietly been wired', () => {
    const nowWired = KNOWN_UNWIRED.filter((name) => wired.has(name));
    expect(nowWired).toEqual([]);
  });

  it('the known gaps are all really offered and really unblocked', () => {
    const offeredNames = new Set(offered.map((tool) => tool.name));
    for (const name of KNOWN_UNWIRED) {
      expect(offeredNames.has(name), `${name} is no longer offered by voice`).toBe(true);
    }
  });

  /**
   * The executor must not reach past the registry either. A key here that no tool declares would
   * be a capability with no `effect`, no `capability` and no `confirmation` - which is precisely
   * the eight-answer discipline the registry exists to enforce.
   */
  it('the executor defines nothing the registry does not declare', () => {
    const declared = new Set<string>(allTools().map((tool) => tool.name));
    expect([...wired].filter((name) => !declared.has(name))).toEqual([]);
  });

  /**
   * `TOUCH_ONLY` is enforced twice on purpose (VOICE_MODE.md section 3): the agent is never told
   * the tool exists, and the dispatcher refuses it if a call arrives anyway. An executor entry for
   * one would be a third path that neither of those covers.
   */
  it('no touch-only tool has an executor at all', () => {
    const touchOnly = allTools().filter((tool) => tool.voice === 'TOUCH_ONLY');
    expect(touchOnly.length).toBeGreaterThan(0);
    expect(touchOnly.map((tool) => tool.name).filter((name) => wired.has(name))).toEqual([]);
  });
});

/**
 * A write that did not happen is never reported as one that did.
 *
 * `VoiceProvider.run` speaks `done` - "Done." - when a tool returns no sentences at all:
 *
 * ```ts
 * speak(parts.length === 0 ? [{ kind: 'UTTERANCE', key: 'done' }] : parts, lines);
 * ```
 *
 * That is right for a tool that succeeded quietly and wrong for one that failed, and three of the
 * four writes returned `{ spoken: [] }` for **every** non-OK outcome - offline, refused, server
 * error, session lost. So "set a reminder for my tablet at eight" with no signal created nothing,
 * queued nothing, and answered "Done." (`DEV-085`).
 *
 * `record_dose` was the only one that handled it, which is why `OFF-6` on hardware never caught
 * the others: it measures the dose path.
 */
describe('a write that failed says so (DEV-085)', () => {
  const FAILURES = [
    'OFFLINE',
    'REFUSED',
    'SERVER_ERROR',
    'UNAVAILABLE',
    'UNAUTHENTICATED',
    'AUTHORIZATION_LOST',
    'STEP_UP_REQUIRED',
  ] as const;

  function executorAnswering(kind: (typeof FAILURES)[number]) {
    const failure = { kind } as never;
    const client = {
      createSchedule: () => Promise.resolve(failure),
      createItem: () => Promise.resolve(failure),
      recordDoseEvent: () => Promise.resolve(failure),
    } as unknown as KynvioraClient;
    return createToolExecutor(client, {} as VoiceBridge, () => Promise.resolve(false));
  }

  const CALLS = {
    create_schedule: {
      name: 'create_schedule',
      arguments: { itemId: 'i1', timesOfDay: '08:00', timeZone: 'Europe/London' },
    },
    add_medicine: {
      name: 'add_medicine',
      arguments: { profileId: 'p1', displayName: 'Synthetic Tablet A' },
    },
    add_personal_care_item: {
      name: 'add_personal_care_item',
      arguments: { profileId: 'p1', displayName: 'Hand cream', personalCareCategory: 'SKIN_CARE' },
    },
  } as const;

  for (const [tool, call] of Object.entries(CALLS)) {
    for (const kind of FAILURES) {
      it(`${tool} says something when the write answers ${kind}`, async () => {
        const executor = executorAnswering(kind);
        expect(executor[tool]).toBeDefined();
        const result = await resultOf(executor, tool, call);
        // The condition `run` actually applies. Empty on both channels is "Done."
        const parts = (result?.utterances ?? []).length + (result?.spoken ?? []).length;
        expect(parts, `${tool} on ${kind} would have been spoken as "Done."`).toBeGreaterThan(0);
      });
    }
  }

  it('offline is reported as no connection, not as kept', async () => {
    const executor = executorAnswering('OFFLINE');
    const result = await resultOf(executor, 'create_schedule', CALLS.create_schedule);
    // `queued` promises the phone kept it and will send it. Nothing queues a schedule by voice.
    expect(result?.utterances).toEqual(['offline']);
    expect(result?.utterances).not.toContain('queued');
  });

  it('and a write that succeeded still says nothing, so `run` says Done.', async () => {
    const client = {
      createSchedule: () => Promise.resolve({ kind: 'OK', value: {} }),
    } as unknown as KynvioraClient;
    const executor = createToolExecutor(client, {} as VoiceBridge, () => Promise.resolve(false));
    const result = await resultOf(executor, 'create_schedule', CALLS.create_schedule);
    expect(result?.utterances ?? []).toEqual([]);
    expect(result?.focusId).toBe('i1');
  });
});
