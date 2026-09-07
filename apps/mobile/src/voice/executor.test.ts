/**
 * What the registry offers, against what the executor can actually do.
 *
 * Spec references: `17`, `docs/design/VOICE_MODE.md` sections 3 and 4, DEC-136, DEC-141.
 *
 * WHY THIS TEST EXISTS
 * `docs/design/VOICE_MODE.md` states the property the whole layer rests on: "the agent's reach is
 * the app's reach". The registry is what the agent is **told** it may call - `voiceCallableTools`
 * is literally the list handed to a provider - and the executor is what can actually run. Nothing
 * compared the two, and they had disagreed for as long as both existed: six tools were
 * `voice: 'ALLOWED'` with `blockedBy: null` and had no executor entry, so `dispatch` refused them
 * at its last step with `BLOCKED` and no blocker identifier. A person asking "is there anything I
 * should know about my medicines" was told that part of Kynviora is not finished (`DEV-084`).
 *
 * All six are wired now and `KNOWN_UNWIRED` is empty, which is the state this file exists to keep.
 * It is deliberately not deleted along with the gap: the assertions below are what stop the next
 * tool being added to the registry without an executor, and an empty allowlist is the strongest
 * form of the claim rather than a leftover.
 *
 * The four checks are two pairs. Two say the registry does not over-claim - every offered tool can
 * run, and nothing on the known-gap list has quietly been wired without being removed from it. Two
 * say the executor does not over-reach - it defines nothing the registry has not declared with its
 * eight answers, and it defines nothing marked `TOUCH_ONLY`, which is the third path neither of
 * `TOUCH_ONLY`'s two enforcement points would cover.
 */

import { describe, it, expect } from 'vitest';
import { allTools, voiceCallableTools } from '@kynviora/agent';
import { createToolExecutor, type ToolResult, type VoiceBridge } from './executor';
import type { ItemUpdateBody, ScheduleChangeBody } from '@kynviora/contracts';
import { safetyInboxView, type KynvioraClient } from '@kynviora/contracts';
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
 * Tools that are offered by voice and cannot run.
 *
 * Empty, and it is meant to stay empty. An entry here is a claim Voice Mode makes and cannot
 * honour, so adding one needs a reason written down beside it.
 */
const KNOWN_UNWIRED: readonly string[] = [];

/**
 * A client and a bridge that do nothing.
 *
 * The executor is built rather than mocked because the question is which **keys** it defines, and
 * a hand-written list of keys would be a second copy of the thing under test.
 */
function executorKeys(): ReadonlySet<string> {
  const client = {} as KynvioraClient;
  const bridge = {} as VoiceBridge;
  const executor = createToolExecutor(
    client,
    bridge,
    () => Promise.resolve(false),
    () => Promise.resolve([]),
  );
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
      .filter((name) => !KNOWN_UNWIRED.includes(name));
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
    const offeredNames = new Set<string>(offered.map((tool) => tool.name));
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
    return createToolExecutor(
      client,
      {} as VoiceBridge,
      () => Promise.resolve(false),
      () => Promise.resolve([]),
    );
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
    const executor = createToolExecutor(
      client,
      {} as VoiceBridge,
      () => Promise.resolve(false),
      () => Promise.resolve([]),
    );
    const result = await resultOf(executor, 'create_schedule', CALLS.create_schedule);
    expect(result?.utterances ?? []).toEqual([]);
    expect(result?.focusId).toBe('i1');
  });
});

/**
 * The six that were declared and unrunnable (`DEV-084`), now behaving.
 *
 * Not "does it call the client" tests. Each asserts the property that made the tool worth wiring
 * carefully rather than quickly - the rule a plausible implementation would break while still
 * passing a smoke test.
 */
describe('the six tools DEV-084 was about', () => {
  function executorWith(client: Partial<KynvioraClient>, pending: readonly unknown[] = []) {
    return createToolExecutor(
      client as KynvioraClient,
      {} as VoiceBridge,
      () => Promise.resolve(false),
      () => Promise.resolve(pending as never),
    );
  }

  function inbox(lines: readonly unknown[], totalItems: number) {
    return {
      kind: 'OK',
      value: { totalItems, lines },
    } as never;
  }

  function line(id: string, displayName: string, state: string) {
    return {
      ownedItemId: id,
      displayName,
      alertPublicationId: null,
      state,
      urgency: null,
      evidenceLevel: null,
      matchConfidence: null,
    };
  }

  function schedule(version: number) {
    return {
      id: 's1',
      ownedItemId: 'i1',
      scheduleKind: 'FIXED_TIMES',
      timesLocal: ['08:00'],
      daysOfWeek: null,
      timeZone: 'Europe/London',
      startsOn: null,
      endsOn: null,
      active: true,
      version,
      updatedAt: null,
    };
  }

  /**
   * `09` requires the coverage statement to accompany the result, and `23` D-014 is that an
   * absence of a matched rule must never render as approval.
   *
   * Spoken, that is stricter than on a screen. A screen keeps the statement visible while somebody
   * reads the list; a sentence is gone once said. Five "Nothing matched" lines read out with no
   * qualification is the shelf-has-been-cleared reading, so the statement goes first.
   */
  it('list_safety_state says the coverage statement before any line', async () => {
    const executor = executorWith({
      safetyInbox: () =>
        Promise.resolve(
          inbox(
            [
              line('i1', 'Synthetic Tablet A', 'NO_CURRENT_MATCHED_ALERT'),
              line('i2', 'Synthetic Capsule B', 'INSUFFICIENT_DATA'),
            ],
            2,
          ),
        ),
    });
    const result = await resultOf(executor, 'list_safety_state', {
      name: 'list_safety_state',
      arguments: { profileId: 'p1' },
    });
    const spoken = result?.spoken ?? [];
    const expected = safetyInboxView({ totalItems: 2, lines: [] }).coverageStatement;
    expect(spoken[0]).toBe(expected);
    expect(spoken.indexOf('Synthetic Tablet A')).toBeGreaterThan(0);
  });

  it('list_safety_state speaks no count and no ranking', async () => {
    const executor = executorWith({
      safetyInbox: () => Promise.resolve(inbox([line('i1', 'A', 'NO_CURRENT_MATCHED_ALERT')], 5)),
    });
    const result = await resultOf(executor, 'list_safety_state', {
      name: 'list_safety_state',
      arguments: { profileId: 'p1' },
    });
    const joined = (result?.spoken ?? []).join(' ');
    // `02` forbids an aggregate. Neither the total nor an attention count reaches the sentence.
    expect(joined).not.toMatch(/\b5\b/);
    expect(joined).not.toMatch(/needs? attention/i);
  });

  /**
   * `23` D-005: evidence level and action urgency are never merged into one visual - and out loud,
   * never into one phrase.
   */
  it('describe_alert keeps urgency and evidence as separate lines', async () => {
    const executor = executorWith({
      alertDetail: () =>
        Promise.resolve({
          kind: 'OK',
          value: {
            alertPublicationId: 'a1',
            ownedItemId: 'i1',
            isLive: true,
            withdrawn: false,
            message: ['A recall applies to this batch.'],
            urgency: 'ACT_NOW',
            evidenceLevel: 'A',
            matchConfidence: 'EXACT',
            facts: [],
            reasons: [],
            source: { summary: 'Regulator notice', reference: null, attribution: null },
            coverageStatement: 'Kynviora checked the sources it monitors.',
            actions: [],
          },
        } as never),
    });
    const result = await resultOf(executor, 'describe_alert', {
      name: 'describe_alert',
      arguments: { alertId: 'a1' },
    });
    const spoken = result?.spoken ?? [];
    expect(result?.focusId).toBe('a1');
    const merged = spoken.filter((entry) => /urgen/i.test(entry) && /evidence/i.test(entry));
    expect(merged).toEqual([]);
    expect(spoken).toContain('Kynviora checked the sources it monitors.');
  });

  /**
   * `caregiverAccessRows` falls back to the grantee's user ID where no name was sent. Right beside
   * a control; wrong in a sentence, which puts an identifier into a room and tells nobody anything.
   */
  it('list_caregiver_access never reads a bare user ID aloud', async () => {
    const executor = executorWith({
      listCaregiverGrants: () =>
        Promise.resolve({
          kind: 'OK',
          value: {
            serverTime: '2026-09-07T00:00:00.000Z',
            grants: [
              {
                id: 'g1',
                profileId: 'p1',
                granteeUserId: '3f6b1c2e-9a4d-4f8b-8c1a-2d5e7f9b0c31',
                grantedByUserId: 'u0',
                capabilities: ['VIEW_MEDICINES'],
                status: 'ACTIVE',
                invitedAt: '2026-09-01T00:00:00.000Z',
                acceptedAt: '2026-09-02T00:00:00.000Z',
                expiresAt: null,
                revokedAt: null,
              },
            ],
          },
        } as never),
    });
    const result = await resultOf(executor, 'list_caregiver_access', {
      name: 'list_caregiver_access',
      arguments: { profileId: 'p1' },
    });
    const joined = (result?.spoken ?? []).join(' ');
    expect(joined).not.toContain('3f6b1c2e');
    expect(joined.length).toBeGreaterThan(0);
  });

  it('list_pending_changes reads the journal and names no code', async () => {
    const executor = executorWith({}, [
      {
        operationId: 'op1',
        entityType: 'medicine_schedule',
        entityId: 'i1',
        mutation: 'CREATE',
        payload: {},
        baseVersion: null,
        createdAt: '2026-09-07T00:00:00.000Z',
        state: 'PENDING',
        attemptCount: 0,
        lastError: null,
      },
    ]);
    const result = await resultOf(executor, 'list_pending_changes', {
      name: 'list_pending_changes',
      arguments: {},
    });
    const joined = (result?.spoken ?? []).join(' ');
    expect(joined.length).toBeGreaterThan(0);
    // Never a code, never a correlation ID (`18`, `14`).
    expect(joined).not.toContain('op1');
    expect(joined).not.toContain('medicine_schedule');
  });

  /**
   * The version is read before the write because `updateItem` is conditional on it rather than
   * carrying a key. A tool that guessed would either fail every time or overwrite what changed
   * underneath.
   */
  it('update_item reads the current version and sends it', async () => {
    const captured: { body?: ItemUpdateBody } = {};
    const executor = executorWith({
      itemDetail: () => Promise.resolve({ kind: 'OK', value: { id: 'i1', version: 7 } } as never),
      updateItem: (_id, body) => {
        captured.body = body;
        return Promise.resolve({ kind: 'OK', value: {} } as never);
      },
    });
    const result = await resultOf(executor, 'update_item', {
      name: 'update_item',
      arguments: { itemId: 'i1', field: 'displayName', value: 'Tablet A' },
    });
    expect(captured.body).toBeDefined();
    expect(captured.body?.expectedVersion).toBe(7);
    expect(captured.body?.displayName).toBe('Tablet A');
    expect(result?.focusId).toBe('i1');
  });

  /**
   * DEC-146 on the one argument that names a property. A `switch` rather than `{ [field]: value }`
   * means a field the registry never declared produces nothing at all, rather than a request
   * carrying whatever the model said.
   */
  it('update_item writes nothing for a field the registry never declared', async () => {
    let called = false;
    const executor = executorWith({
      itemDetail: () => Promise.resolve({ kind: 'OK', value: { id: 'i1', version: 1 } } as never),
      updateItem: () => {
        called = true;
        return Promise.resolve({ kind: 'OK', value: {} } as never);
      },
    });
    for (const field of ['__proto__', 'constructor', 'toString', 'lifecycleState', 'nonsense']) {
      const result = await resultOf(executor, 'update_item', {
        name: 'update_item',
        arguments: { itemId: 'i1', field, value: 'x' },
      });
      expect(called, `${field} reached the write`).toBe(false);
      expect(result?.utterances ?? []).not.toEqual([]);
    }
  });

  it('update_schedule sends the whole document at the version it read', async () => {
    const captured: { body?: ScheduleChangeBody } = {};
    const executor = executorWith({
      schedules: () =>
        Promise.resolve({
          kind: 'OK',
          value: { serverTime: '2026-09-07T00:00:00.000Z', schedules: [schedule(3)] },
        } as never),
      updateSchedule: (_id, body) => {
        captured.body = body;
        return Promise.resolve({ kind: 'OK', value: {} } as never);
      },
    });
    const result = await resultOf(executor, 'update_schedule', {
      name: 'update_schedule',
      arguments: { itemId: 'i1', scheduleId: 's1', timesOfDay: '09:00,21:00' },
    });
    expect(captured.body?.expectedVersion).toBe(3);
    expect(captured.body?.timesLocal).toEqual(['09:00', '21:00']);
    expect(captured.body?.timeZone).toBe('Europe/London');
    expect(result?.focusId).toBe('i1');
  });

  it('update_schedule leaves the times alone when none were given', async () => {
    const captured: { body?: ScheduleChangeBody } = {};
    const executor = executorWith({
      schedules: () =>
        Promise.resolve({
          kind: 'OK',
          value: { serverTime: '2026-09-07T00:00:00.000Z', schedules: [schedule(3)] },
        } as never),
      updateSchedule: (_id, body) => {
        captured.body = body;
        return Promise.resolve({ kind: 'OK', value: {} } as never);
      },
    });
    await resultOf(executor, 'update_schedule', {
      name: 'update_schedule',
      arguments: { itemId: 'i1', scheduleId: 's1', active: false },
    });
    expect(captured.body?.timesLocal).toEqual(['08:00']);
    expect(captured.body?.active).toBe(false);
  });

  it('update_schedule writes nothing for a schedule the item does not have', async () => {
    let called = false;
    const executor = executorWith({
      schedules: () =>
        Promise.resolve({
          kind: 'OK',
          value: { serverTime: '2026-09-07T00:00:00.000Z', schedules: [] },
        } as never),
      updateSchedule: () => {
        called = true;
        return Promise.resolve({ kind: 'OK', value: {} } as never);
      },
    });
    const result = await resultOf(executor, 'update_schedule', {
      name: 'update_schedule',
      arguments: { itemId: 'i1', scheduleId: 'nope' },
    });
    expect(called).toBe(false);
    expect(result?.utterances ?? []).not.toEqual([]);
  });

  /** `DEV-085`'s rule, applied to the two writes wired here. */
  it('both new writes say so when the write fails', async () => {
    const failing = executorWith({
      itemDetail: () => Promise.resolve({ kind: 'OK', value: { id: 'i1', version: 1 } } as never),
      updateItem: () => Promise.resolve({ kind: 'SERVER_ERROR' } as never),
      schedules: () =>
        Promise.resolve({
          kind: 'OK',
          value: { serverTime: '2026-09-07T00:00:00.000Z', schedules: [schedule(1)] },
        } as never),
      updateSchedule: () => Promise.resolve({ kind: 'OFFLINE' } as never),
    });

    const item = await resultOf(failing, 'update_item', {
      name: 'update_item',
      arguments: { itemId: 'i1', field: 'notes', value: 'x' },
    });
    expect(item?.utterances).toEqual(['didNotGoThrough']);

    const scheduleResult = await resultOf(failing, 'update_schedule', {
      name: 'update_schedule',
      arguments: { itemId: 'i1', scheduleId: 's1', timesOfDay: '09:00' },
    });
    expect(scheduleResult?.utterances).toEqual(['offline']);
  });

  /** A read that fails is silent rather than inventing an answer. */
  it('a read that fails says nothing about the shelf', async () => {
    const executor = executorWith({
      safetyInbox: () => Promise.resolve({ kind: 'SERVER_ERROR' } as never),
    });
    const result = await resultOf(executor, 'list_safety_state', {
      name: 'list_safety_state',
      arguments: { profileId: 'p1' },
    });
    expect(result?.spoken ?? []).toEqual([]);
  });
});
