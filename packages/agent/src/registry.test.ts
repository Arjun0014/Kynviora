/**
 * What the registry may and may not contain.
 *
 * Spec references: `17` (AI boundaries - the prohibited list), `14`, `16`, `11`, `13`, `02`,
 * `09`. DEC-132, DEC-133.
 *
 * These are the assertions that make the safety rules **enforced** rather than described. Every
 * one of them fails on a plausible future edit: adding a tool for changing a dose, marking the
 * Visit Pack voice-callable to be helpful, or letting a write slip through without confirmation.
 */

import { describe, it, expect } from 'vitest';
import {
  allTools,
  blockedTools,
  everyToolNameIsDefined,
  toolNamed,
  voiceCallableTools,
} from './registry.js';
import { TOOL_NAMES, isToolName, validateArguments, type ToolDefinition } from './tools.js';
import { summariseProposal } from './summary.js';
import { DOSE_EVENT_KINDS } from '@kynviora/domain';

const TOOLS = allTools();

describe('the registry is complete and closed', () => {
  it('defines every name in the vocabulary, and no more', () => {
    expect(everyToolNameIsDefined()).toBe(true);
    expect(TOOLS).toHaveLength(TOOL_NAMES.length);
    expect(new Set(TOOLS.map((tool) => tool.name)).size).toBe(TOOLS.length);
  });

  it('answers nothing for a name nobody defined', () => {
    // A hallucinated tool name is a lookup miss. `17`'s "models propose" is exactly this: the
    // proposal is checked against a list somebody wrote.
    expect(toolNamed('change_dose')).toBeNull();
    expect(toolNamed('run_sql')).toBeNull();
    expect(toolNamed('')).toBeNull();
    expect(isToolName('change_dose')).toBe(false);
  });
});

describe('what `17` forbids has no name to be called by', () => {
  /**
   * The prohibited list from `17`, as words a tool would have to contain to express one.
   *
   * A word test rather than a review note. The rule is not "nobody should add a tool that changes
   * a dose"; it is that this test fails if somebody does.
   */
  const FORBIDDEN_FRAGMENTS = [
    'prescrib',
    'diagnos',
    'dose_change',
    'change_dose',
    'increase',
    'decrease',
    'double',
    'stop_taking',
    'substitut',
    'replace_medicine',
    'recommend',
    'advise',
    'is_safe',
    'safety_score',
    'rank',
  ];

  it.each(FORBIDDEN_FRAGMENTS)('has no tool whose name contains "%s"', (fragment) => {
    for (const tool of TOOLS) {
      expect(tool.name.toLowerCase()).not.toContain(fragment);
    }
  });

  it('describes no tool as advising, recommending or judging', () => {
    // The descriptions are what a provider would be shown, so they are part of the boundary: a
    // description reading "recommend a medicine" is an instruction to a model to try.
    for (const tool of TOOLS) {
      const description = tool.description.toLowerCase();
      for (const fragment of ['recommend', 'advise', 'prescribe', 'diagnose', 'is safe']) {
        expect(description).not.toContain(fragment);
      }
    }
  });

  it('has no tool that writes to the shared catalog or to regulatory truth', () => {
    // `17`: a model may never write shared catalog or regulatory truth, and `08` says a user write
    // cannot either. There is no route for it, and there is no tool naming one.
    for (const tool of TOOLS) {
      for (const fragment of ['catalog', 'regulatory', 'publish', 'approve', 'rule']) {
        expect(tool.name.toLowerCase()).not.toContain(fragment);
      }
    }
  });
});

describe('what voice may reach', () => {
  it('never offers a tool that needs fresh identity', () => {
    // `14` requires re-authentication for high-impact actions and nothing in this build can
    // re-authenticate by voice. A spoken "yes" is a far weaker act than a typed password, and the
    // room an older adult uses a voice interface in is a room with other people in it.
    for (const tool of TOOLS) {
      if (tool.stepUp) expect(tool.voice).toBe('TOUCH_ONLY');
    }
  });

  it('keeps the account, sharing, consent and access controls off the voice path', () => {
    const mustBeTouchOnly = [
      'delete_account',
      'delete_item',
      'export_my_data',
      'prepare_visit_pack',
      'record_consent',
      'invite_caregiver',
      'revoke_caregiver_access',
    ] as const;
    for (const name of mustBeTouchOnly) {
      expect(toolNamed(name)?.voice).toBe('TOUCH_ONLY');
    }
  });

  it('does not list a touch-only tool as something an agent may call', () => {
    // The first of the two mechanisms: an agent is never told these exist as things to call. The
    // second is the dispatcher refusing one that arrives anyway. Either alone is a policy; both
    // together are a boundary.
    const callable = new Set(voiceCallableTools().map((tool) => tool.name));
    expect(callable.has('delete_account')).toBe(false);
    expect(callable.has('prepare_visit_pack')).toBe(false);
    expect(voiceCallableTools().every((tool) => tool.voice === 'ALLOWED')).toBe(true);
  });

  it('still lists them in the registry, so the agent can say where they are', () => {
    // Absent from the registry and the agent would say the capability does not exist, which is
    // false and unhelpful. Present and `TOUCH_ONLY`, and it can say where the control is.
    expect(toolNamed('delete_account')).not.toBeNull();
    expect(toolNamed('prepare_visit_pack')?.surface).toBe('TODAY');
  });
});

describe('confirmation', () => {
  it('confirms every write', () => {
    for (const tool of TOOLS) {
      if (tool.effect === 'WRITE') expect(tool.confirmation).toBe('EXPLICIT');
    }
  });

  it('never confirms a read or a navigation', () => {
    // Asking permission to read something out is noise, and noise is what teaches somebody to
    // confirm without listening.
    for (const tool of TOOLS) {
      if (tool.effect === 'READ' || tool.effect === 'NAVIGATE') {
        expect(tool.confirmation).toBe('NONE');
      }
    }
  });

  it('confirms opening the camera, which writes nothing', () => {
    // `16` treats a capture as a deliberate act. Pointing a lens at somebody's home on a misheard
    // word is a thing worth one question, and it is the reason `confirmation` is a separate field
    // from `effect` rather than derived from it.
    expect(toolNamed('start_package_capture')?.confirmation).toBe('EXPLICIT');
    expect(toolNamed('start_package_capture')?.effect).toBe('DEVICE');
  });

  it('has a written summary for everything a person can agree to by voice', () => {
    // The summary is the whole of the consent, and it is composed here rather than by a model:
    // "shall I record that you took it" is one word from "shall I record that you skipped it",
    // and both are fluent.
    //
    // Scoped to the voice-callable tools on purpose. A `TOUCH_ONLY` tool is confirmed on a screen
    // that already exists and already says what it will do - the caregiver review step, the Visit
    // Pack review, the deletion screen that names all four things it removes. Writing a second
    // spoken summary for those would be a second description of the same act, and two
    // descriptions of one act is how they come to disagree.
    for (const tool of TOOLS) {
      if (tool.confirmation !== 'EXPLICIT' || tool.voice !== 'ALLOWED') continue;
      const summary = summariseProposal(
        tool,
        { name: tool.name, arguments: sampleArgs(tool) },
        'Tablet A',
      );
      expect(summary).not.toBe(tool.description);
      expect(summary.length).toBeGreaterThan(0);
    }
  });

  it('names the medicine in the sentence rather than an identifier', () => {
    // An ID read out loud describes nothing. The label is resolved by the caller from a tool
    // result, and where there is none the sentence says "this item" - which the screen showing
    // the item alongside makes unambiguous.
    const record = toolNamed('record_dose');
    const withLabel = summariseProposal(
      record!,
      { name: 'record_dose', arguments: { itemId: 'abc-123', eventKind: 'SKIPPED' } },
      'Metformin 500 mg',
    );
    expect(withLabel).toContain('Metformin 500 mg');
    expect(withLabel).toContain('skipped');
    expect(withLabel).not.toContain('abc-123');

    const withoutLabel = summariseProposal(
      record!,
      { name: 'record_dose', arguments: { itemId: 'abc-123', eventKind: 'TAKEN' } },
      null,
    );
    expect(withoutLabel).toContain('this item');
    expect(withoutLabel).not.toContain('abc-123');
  });

  it("reads a person's own note back word for word", () => {
    // The same rule the dose note already follows on the screen: this app does not tidy what
    // somebody wrote about their own treatment.
    const record = toolNamed('record_dose');
    const summary = summariseProposal(
      record!,
      {
        name: 'record_dose',
        arguments: { itemId: 'i1', eventKind: 'TAKEN', note: 'felt dizzy after' },
      },
      'Tablet A',
    );
    expect(summary).toContain('"felt dizzy after"');
  });
});

describe('capability and offline behaviour', () => {
  it('asks for a capability on everything that touches a person, and nothing on what does not', () => {
    for (const tool of TOOLS) {
      const takesProfile = tool.parameters.some((parameter) => parameter.name === 'profileId');
      const takesItem = tool.parameters.some((parameter) => parameter.name === 'itemId');
      if (takesProfile || takesItem) expect(tool.capability).not.toBe('NONE');
    }
  });

  it('puts deletion and account control behind ownership rather than a capability', () => {
    // No caregiver capability authorises deletion at any level (docs/RETENTION.md section 2), so
    // it must not be expressible as one - a future `MANAGE_MEDICINES` holder would inherit it.
    for (const name of ['delete_item', 'delete_account', 'export_my_data'] as const) {
      expect(toolNamed(name)?.capability).toBe('OWNER_ONLY');
    }
  });

  it('lets the three writes `03` group J promises reach the journal with no signal', () => {
    // A dose, and since DEC-148 a schedule set or changed. Those are what the offline journal
    // carries, and `QUEUES` is what makes gate 5 let them through to reach it.
    for (const name of ['record_dose', 'create_schedule', 'update_schedule'] as const) {
      expect(toolNamed(name)?.offline).toBe('QUEUES');
    }
  });

  /**
   * This used to assert `list_medicines` is `LOCAL_PROJECTION`, and it was measuring a word.
   *
   * `03` group J does require the shelf to be readable with no signal, and it is - by the shelf,
   * which reads the encrypted projection through `useResource`. A **tool** executes by calling the
   * `KynvioraClient` method directly, and the client has no projection in it: nine reads declared
   * `LOCAL_PROJECTION` and not one of them could be answered without the network (`DEV-091`).
   *
   * So the claim is gone rather than the requirement. What is left is a rule about the three that
   * still make it, which is that `LOCAL_PROJECTION` now means something a caller can rely on:
   * two navigations that touch nothing, and the pending-changes list, which reads this phone's own
   * journal. `apps/mobile/src/voice/executor.test.ts` drives each of them against a client where
   * every method answers `OFFLINE` and requires a real answer, so the declaration cannot become
   * aspirational again without a test going red.
   */
  it('claims to work offline only where nothing has to be asked of a server', () => {
    const local = TOOLS.filter((tool) => tool.offline === 'LOCAL_PROJECTION');
    expect(local.map((tool) => tool.name).sort()).toEqual([
      'list_pending_changes',
      'open_item',
      'open_screen',
    ]);
    // And none of them writes. A write claiming to work offline without reaching the journal is
    // a change that vanishes - `QUEUES` is the only honest offline answer a write can give, which
    // is the rule `DEV-055` and `DEV-085` are two halves of.
    for (const tool of local) {
      expect(tool.effect, `${tool.name} writes and claims to need no server`).not.toBe('WRITE');
    }
  });

  it('is honest that everything else needs the server', () => {
    // A tool claiming to work offline that does not is a queued write nobody sent, which is the
    // failure `DEV-055` was - and a read nobody could answer, which is the one `DEV-090` was.
    for (const name of ['add_medicine', 'invite_caregiver', 'list_medicines'] as const) {
      expect(toolNamed(name)?.offline).toBe('ONLINE_ONLY');
    }
  });
});

describe('what is blocked, and says so', () => {
  it('names the blocker on every tool that cannot work', () => {
    // Extraction is the whole of this group. `17` requires dual extraction and neither engine is
    // credentialed, so proposing a field would be fabricating one.
    const blocked = blockedTools();
    expect(blocked.map((tool) => tool.name).sort()).toEqual([
      'confirm_extracted_item',
      'read_extracted_fields',
    ]);
    for (const tool of blocked) {
      expect(tool.blockedBy).toBe('BLK-007');
    }
  });

  it('keeps the capture tools themselves unblocked, because a camera exists', () => {
    // The photograph is real and the reading of it is not. Blocking the camera as well would be
    // saying the app cannot take a picture, which is not true and would lose the evidence.
    expect(toolNamed('start_package_capture')?.blockedBy).toBeNull();
    expect(toolNamed('capture_next_package_photo')?.blockedBy).toBeNull();
  });
});

describe('argument validation', () => {
  const listMedicines = toolNamed('list_medicines');

  it('accepts what a tool declares', () => {
    expect(validateArguments(listMedicines!, { profileId: 'p1' }).ok).toBe(true);
  });

  it('refuses an argument the tool does not declare', () => {
    // A model that invented `includeOtherHouseholds` must not be able to smuggle it past a tool
    // that does not take one. Strict, for the reason the API bodies are.
    const result = validateArguments(listMedicines!, {
      profileId: 'p1',
      includeOtherHouseholds: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal).toBe('UNEXPECTED_ARGUMENT');
      expect(result.parameter).toBe('includeOtherHouseholds');
    }
  });

  it('refuses a missing required argument, and an empty one', () => {
    expect(validateArguments(listMedicines!, {}).ok).toBe(false);
    // An empty string is a missing value wearing the right type.
    expect(validateArguments(listMedicines!, { profileId: '   ' }).ok).toBe(false);
  });

  it('refuses an enum value nobody listed', () => {
    const record = toolNamed('record_dose');
    expect(validateArguments(record!, { itemId: 'i1', eventKind: 'TAKEN' }).ok).toBe(true);
    expect(validateArguments(record!, { itemId: 'i1', eventKind: 'DOUBLED' }).ok).toBe(false);
  });

  it('offers exactly the dose events the domain has, and no invented fifth', () => {
    // A tool proposing `TAKEN_LATE` would be proposing a dose event the database has a CHECK
    // against, and the refusal would arrive as a 500 rather than as a sentence. This is the
    // assertion that keeps the declaration and the vocabulary from drifting.
    const record = toolNamed('record_dose');
    const eventKind = record?.parameters.find((parameter) => parameter.name === 'eventKind');
    expect(eventKind?.values).toEqual([...DOSE_EVENT_KINDS]);
  });

  it('names every dose event in a sentence somebody could agree to', () => {
    // A missing phrase would fall through to "what happened", which is a summary that does not
    // say which of four things is about to be written.
    const record = toolNamed('record_dose');
    for (const kind of DOSE_EVENT_KINDS) {
      const summary = summariseProposal(
        record!,
        { name: 'record_dose', arguments: { itemId: 'i1', eventKind: kind } },
        'Tablet A',
      );
      expect(summary, kind).not.toContain('what happened');
    }
  });

  it('refuses a value of the wrong type, including one that would coerce', () => {
    const update = toolNamed('update_schedule');
    // `itemId` as well as `scheduleId` since `DEV-084`: the change is whole-document and
    // conditional on a version, and `schedules(itemId)` is the only read that finds the row.
    expect(validateArguments(update!, { itemId: 'i1', scheduleId: 's1', active: false }).ok).toBe(
      true,
    );
    // `'false'` is truthy and would have turned off nothing.
    expect(validateArguments(update!, { itemId: 'i1', scheduleId: 's1', active: 'false' }).ok).toBe(
      false,
    );
    // And the item is required rather than optional, so a call without it is refused here rather
    // than reaching an executor that cannot resolve the schedule.
    expect(validateArguments(update!, { scheduleId: 's1', active: false }).ok).toBe(false);
  });
});

/** Valid arguments for a tool, so the summary assertions have something to work on. */
function sampleArgs(tool: ToolDefinition): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const parameter of tool.parameters) {
    if (!parameter.required) continue;
    switch (parameter.type) {
      case 'string':
        args[parameter.name] = 'x';
        break;
      case 'number':
        args[parameter.name] = 1;
        break;
      case 'boolean':
        args[parameter.name] = true;
        break;
      case 'enum':
        args[parameter.name] = parameter.values?.[0] ?? '';
        break;
    }
  }
  return args;
}
