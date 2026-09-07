/**
 * Voice Mode on a screen: what a conversation does to the app, and what it cannot do to it.
 *
 * Spec references: `17` (the agent's reach is the app's reach), `13`, `14`, `12`, `18`.
 * DEC-132 to DEC-136, `BLK-012`.
 *
 * WHAT THIS ADDS OVER `packages/agent`
 * That package is tested without React and proves the gates. This one proves the **wiring**: that
 * the executor really is the `KynvioraClient`, that a refusal reaches the transcript rather than
 * disappearing, that a confirmation released by the machine is the thing that runs, and that a
 * tool cannot reach the client through any other path.
 */

import { describe, it, expect } from 'vitest';
import { Text } from 'react-native';
import { createScriptedAgent, type ScriptedRule, type VoiceProviders } from '@kynviora/agent';
import type { ApiOutcome, KynvioraClient } from '@kynviora/contracts';
import { renderScreen, flush, allNodes, textOf, type Rendered } from '../../test/render';
import { ApiProvider } from '@/api/ApiProvider';
import { ProfileProvider, type ProfileContextValue } from '@/api/ProfileProvider';
import { PendingSyncProvider, type PendingSyncContextValue } from '@/sync/PendingSyncProvider';
import { VoiceProvider, useVoice } from './VoiceProvider';
import type { VoiceBridge } from './executor';

const PROFILE = '00000000-0000-4000-8000-0000000000p1'.replace('p1', '0001');
const ITEM = '00000000-0000-4000-8000-000000000i01'.replace('i01', '0002');

/**
 * Every call the client was asked to make, in order. The heart of every assertion here.
 *
 * `doseOutcome` is what `recordDoseEvent` answers with. Injected because the three answers a dose
 * has - written, kept here, refused - differ only in what the server said, and a test that could
 * not move that would be measuring one of the three (`DEV-071`).
 */
function recordingClient(
  calls: string[],
  doseOutcome?: ApiOutcome<{ readonly id: string; readonly serverTime: string }>,
): KynvioraClient {
  const ok = <T,>(value: T): Promise<ApiOutcome<T>> =>
    Promise.resolve({ kind: 'OK', value, correlationId: null });

  const client = {
    session: { kind: 'ANONYMOUS' as const },
    listItems: (query: { readonly profileId?: string; readonly itemKind?: string }) => {
      calls.push(`listItems:${query.itemKind ?? ''}:${query.profileId ?? ''}`);
      return ok({
        items: [
          {
            id: ITEM,
            profileId: PROFILE,
            itemKind: 'MEDICINE',
            displayName: 'Synthetic Tablet A',
            brand: null,
            verification: 'UNVERIFIED',
            lifecycleState: 'ACTIVE',
            formulationConfirmed: false,
            recordedLotCode: null,
            expiresOn: null,
            lastSafetyCheckedAt: null,
            attentionReasons: [],
          },
        ],
        nextCursor: null,
        mayRecordDoses: true,
      });
    },
    recordDoseEvent: (body: { readonly eventKind: string }, key: string) => {
      calls.push(`recordDoseEvent:${body.eventKind}:${key.length > 0 ? 'keyed' : 'unkeyed'}`);
      return (
        doseOutcome === undefined
          ? ok({ id: 'dose-1', serverTime: '2026-09-07T08:00:00.000Z' })
          : Promise.resolve(doseOutcome)
      ) as Promise<ApiOutcome<{ readonly id: string; readonly serverTime: string }>>;
    },
    listProfiles: () => {
      calls.push('listProfiles');
      return ok({ profiles: [], activeProfileId: null });
    },
    reportTimeZone: () => ok({ recorded: true }),
    readAccount: () => ok({ registeredAt: null, deletedAt: null }),
  } as unknown as KynvioraClient;
  return client;
}

/** A profile context with one chosen person, so a tool has a subject without a network round trip. */
function profileContext(): ProfileContextValue {
  return {
    resource: { state: 'READY', value: { profiles: [] }, message: null, correlationId: null },
    profiles: [],
    activeProfileId: PROFILE,
    activeProfile: null,
    select: () => undefined,
    reload: () => undefined,
  };
}

function bridgeRecording(moves: string[]): VoiceBridge {
  return {
    openScreen: (screen) => moves.push(`screen:${screen}`),
    openItem: (itemId) => moves.push(`item:${itemId}`),
    openCamera: (panel) => moves.push(`camera:${panel}`),
    captureNextPhoto: () => moves.push('capture'),
  };
}

function agentFor(rules: readonly ScriptedRule[]): VoiceProviders {
  return { recognizer: null, agent: createScriptedAgent(rules), synthesizer: null };
}

/** The last line Kynviora said, which is what a person would have heard. */
function lastSpoken(rendered: Rendered): string {
  const lines = allNodes(rendered)
    .filter((node) => String(node.type) === 'Text')
    .map((node) => textOf(node))
    .filter((text) => text.startsWith('K:'));
  return lines.at(-1) ?? '';
}

function pendingSummary(rendered: Rendered): string {
  const lines = allNodes(rendered)
    .filter((node) => String(node.type) === 'Text')
    .map((node) => textOf(node))
    .filter((text) => text.startsWith('P:'));
  return lines.at(-1) ?? '';
}

/** A probe that renders the session and exposes the controls a screen would press. */
function Probe({ script }: { readonly script: string }) {
  const { session, say, confirm, cancel } = useVoice();
  return (
    <>
      <Text>{`STATE:${session.state}`}</Text>
      {session.pending === null ? null : <Text>{`P:${session.pending.summary}`}</Text>}
      {session.transcript.map((entry) => (
        <Text key={entry.id}>
          {entry.speaker === 'KYNVIORA' ? `K:${entry.text}` : `Y:${entry.text}`}
        </Text>
      ))}
      <Text
        accessibilityLabel="say"
        onPress={() => {
          say(script);
        }}
      >
        say
      </Text>
      <Text
        accessibilityLabel="confirm"
        onPress={() => {
          confirm(session.pending?.id ?? 'none');
        }}
      >
        confirm
      </Text>
      <Text accessibilityLabel="cancel" onPress={cancel}>
        cancel
      </Text>
    </>
  );
}

function press(rendered: Rendered, label: string): void {
  const node = allNodes(rendered).find((entry) => entry.props['accessibilityLabel'] === label);
  const onPress = node?.props['onPress'] as (() => void) | undefined;
  onPress?.();
}

/**
 * A journal that records what it was asked to keep, and whether it agreed to.
 *
 * The real one is a table in an encrypted database, which is a device concern
 * (`verify:device:offline` owns it). What is decidable here is the half that regresses silently:
 * whether a failed write is offered to the queue at all, under which key, and what the person is
 * told about the answer.
 */
function recordingJournal(queued: string[], accepts = true): PendingSyncContextValue {
  return {
    queue: (request) => {
      queued.push(
        `${request.entityType}:${request.mutation}:${request.entityId}:${
          request.operationId === undefined ? 'no-key' : 'keyed'
        }`,
      );
      return Promise.resolve(accepts);
    },
    waiting: 0,
    needsAttention: 0,
    registerSender: () => undefined,
    drain: () => undefined,
    list: () => Promise.resolve([]),
    retry: () => Promise.resolve(),
    discard: () => Promise.resolve(),
  };
}

function mount(options: {
  readonly script: string;
  readonly rules: readonly ScriptedRule[];
  readonly calls: string[];
  readonly moves: string[];
  readonly capabilities?: ReadonlySet<string>;
  readonly online?: boolean;
  readonly doseOutcome?: ApiOutcome<{ readonly id: string; readonly serverTime: string }>;
  readonly journal?: PendingSyncContextValue;
}): Rendered {
  return renderScreen(
    <ApiProvider
      value={{
        client: recordingClient(options.calls, options.doseOutcome),
        session: { kind: 'ANONYMOUS' },
        configurationError: null,
        elevate: () => null,
      }}
    >
      <ProfileProvider value={profileContext()}>
        <PendingSyncProvider {...(options.journal === undefined ? {} : { value: options.journal })}>
          <VoiceProvider
            providers={agentFor(options.rules)}
            bridge={bridgeRecording(options.moves)}
            capabilities={
              (options.capabilities ??
                new Set(['VIEW_MEDICINES', 'RECORD_DOSES'])) as ReadonlySet<never>
            }
            online={options.online ?? true}
            now={() => 1_760_000_000_000}
          >
            <Probe script={options.script} />
          </VoiceProvider>
        </PendingSyncProvider>
      </ProfileProvider>
    </ApiProvider>,
  );
}

describe('a question that reads the shelf', () => {
  it('calls the same client method the shelf calls, and reads back what it composed', async () => {
    const calls: string[] = [];
    const rendered = mount({
      script: 'what medicines am i taking',
      rules: [
        {
          whenSaid: /medicines/,
          then: { kind: 'CALL', name: 'list_medicines', arguments: { profileId: PROFILE } },
        },
      ],
      calls,
      moves: [],
    });

    press(rendered, 'say');
    await flush();

    // The client, on the same session, with the profile ID narrowing exactly as the shelf does.
    expect(calls).toEqual([`listItems:MEDICINE:${PROFILE}`]);
    expect(lastSpoken(rendered)).toContain('Synthetic Tablet A');
  });
});

describe('a dose', () => {
  const RULES: readonly ScriptedRule[] = [
    {
      whenSaid: /took/,
      then: {
        kind: 'CALL',
        name: 'record_dose',
        arguments: { itemId: ITEM, eventKind: 'TAKEN' },
      },
    },
  ];

  it('writes nothing until the person confirms the sentence they were shown', async () => {
    const calls: string[] = [];
    const rendered = mount({ script: 'i took it', rules: RULES, calls, moves: [] });

    press(rendered, 'say');
    await flush();
    expect(calls).toEqual([]);
    expect(pendingSummary(rendered)).toContain('took it');

    press(rendered, 'confirm');
    await flush();
    expect(calls).toEqual(['recordDoseEvent:TAKEN:keyed']);
  });

  it('writes nothing when the person says no', async () => {
    const calls: string[] = [];
    const rendered = mount({ script: 'i took it', rules: RULES, calls, moves: [] });
    press(rendered, 'say');
    await flush();
    press(rendered, 'cancel');
    await flush();
    expect(calls).toEqual([]);
    expect(lastSpoken(rendered)).toContain('not done it');
  });

  it('refuses when the server has not granted `RECORD_DOSES`, and never asks it', async () => {
    // DEC-116. The agent is not offering something the write would refuse, and the route would
    // refuse it anyway - this is the half that stops a person filling in a form for nothing.
    const calls: string[] = [];
    const rendered = mount({
      script: 'i took it',
      rules: RULES,
      calls,
      moves: [],
      capabilities: new Set(['VIEW_MEDICINES']),
    });
    press(rendered, 'say');
    await flush();
    expect(calls).toEqual([]);
    expect(pendingSummary(rendered)).toBe('');
    expect(lastSpoken(rendered)).toContain('do not have access');
  });
});

describe('what a conversation cannot do', () => {
  it('does not close an account, whatever the agent proposes', async () => {
    const calls: string[] = [];
    const rendered = mount({
      script: 'delete my account',
      rules: [
        { whenSaid: /delete/, then: { kind: 'CALL', name: 'delete_account', arguments: {} } },
      ],
      calls,
      moves: [],
    });
    press(rendered, 'say');
    await flush();
    expect(calls).toEqual([]);
    expect(lastSpoken(rendered)).toContain('needs the screen');
  });

  it('has nothing to call for a dose change, so the client is never touched', async () => {
    const calls: string[] = [];
    const rendered = mount({
      script: 'double my dose',
      rules: [
        {
          whenSaid: /double/,
          then: { kind: 'CALL', name: 'change_dose', arguments: { itemId: ITEM, multiplier: 2 } },
        },
      ],
      calls,
      moves: [],
    });
    press(rendered, 'say');
    await flush();
    expect(calls).toEqual([]);
  });

  it('drops an argument the agent invented rather than passing it to the client', async () => {
    const calls: string[] = [];
    const rendered = mount({
      script: 'everything for everyone',
      rules: [
        {
          whenSaid: /everything/,
          then: {
            kind: 'CALL',
            name: 'list_medicines',
            arguments: { profileId: PROFILE, includeOtherHouseholds: true },
          },
        },
      ],
      calls,
      moves: [],
    });
    press(rendered, 'say');
    await flush();
    expect(calls).toEqual([]);
  });

  it('says the label cannot be read rather than inventing a field', async () => {
    // `BLK-007`. There is no extraction provider, so there is nothing to read - and a stub saying
    // "nothing was found" would be indistinguishable from an extraction that ran.
    const calls: string[] = [];
    const rendered = mount({
      script: 'what does the box say',
      rules: [
        { whenSaid: /box/, then: { kind: 'CALL', name: 'read_extracted_fields', arguments: {} } },
      ],
      calls,
      moves: [],
      // Granted, on purpose. Without it the refusal is `CAPABILITY_MISSING` and arrives first -
      // which is the right order, and would make this assertion pass for the wrong reason.
      capabilities: new Set(['MANAGE_MEDICINES']),
    });
    press(rendered, 'say');
    await flush();
    expect(calls).toEqual([]);
    expect(lastSpoken(rendered)).toContain('not finished yet');
  });

  it('does not say what is unfinished to somebody who may not use it either way', async () => {
    // The gate order matters here. A caller without the capability hears "you do not have access"
    // and learns nothing about whether extraction is implemented - which is the same argument the
    // API makes by answering 404 for a refusal.
    const rendered = mount({
      script: 'what does the box say',
      rules: [
        { whenSaid: /box/, then: { kind: 'CALL', name: 'read_extracted_fields', arguments: {} } },
      ],
      calls: [],
      moves: [],
      capabilities: new Set(['VIEW_MEDICINES']),
    });
    press(rendered, 'say');
    await flush();
    expect(lastSpoken(rendered)).toContain('do not have access');
    expect(lastSpoken(rendered)).not.toContain('not finished yet');
  });
});

describe('the bridge between voice and touch', () => {
  it('opens a destination without asking the server anything', async () => {
    const calls: string[] = [];
    const moves: string[] = [];
    const rendered = mount({
      script: 'open the shelf',
      rules: [
        {
          whenSaid: /shelf/,
          then: { kind: 'CALL', name: 'open_screen', arguments: { screen: 'SHELF' } },
        },
      ],
      calls,
      moves,
    });
    press(rendered, 'say');
    await flush();
    expect(moves).toEqual(['screen:SHELF']);
    expect(calls).toEqual([]);
  });

  it('asks before opening the camera, and opens it only once confirmed', async () => {
    const moves: string[] = [];
    const rendered = mount({
      script: 'photograph the box',
      rules: [
        {
          whenSaid: /photograph/,
          then: {
            kind: 'CALL',
            name: 'start_package_capture',
            arguments: { profileId: PROFILE, panel: 'FRONT' },
          },
        },
      ],
      calls: [],
      moves,
      capabilities: new Set(['MANAGE_MEDICINES']),
    });
    press(rendered, 'say');
    await flush();
    expect(moves).toEqual([]);
    expect(pendingSummary(rendered)).toContain('front of the pack');

    press(rendered, 'confirm');
    await flush();
    expect(moves).toEqual(['camera:FRONT']);
  });
});

describe('with no agent at all, which is this build', () => {
  it('says it did not understand rather than doing nothing', async () => {
    // `BLK-012`. Silence from a voice interface is a failure, not an answer.
    const calls: string[] = [];
    const rendered = renderScreen(
      <ApiProvider
        value={{
          client: recordingClient(calls),
          session: { kind: 'ANONYMOUS' },
          configurationError: null,
          elevate: () => null,
        }}
      >
        <ProfileProvider value={profileContext()}>
          <VoiceProvider now={() => 1_760_000_000_000}>
            <Probe script="anything at all" />
          </VoiceProvider>
        </ProfileProvider>
      </ApiProvider>,
    );
    press(rendered, 'say');
    await flush();
    expect(lastSpoken(rendered)).toContain('did not catch that');
    expect(calls).toEqual([]);
  });
});

describe('offline', () => {
  it('says so for something that needs the server, and asks it nothing', async () => {
    const calls: string[] = [];
    const rendered = mount({
      script: 'add paracetamol',
      rules: [
        {
          whenSaid: /add/,
          then: {
            kind: 'CALL',
            name: 'add_medicine',
            arguments: { profileId: PROFILE, displayName: 'Paracetamol' },
          },
        },
      ],
      calls,
      moves: [],
      capabilities: new Set(['MANAGE_MEDICINES']),
      online: false,
    });
    press(rendered, 'say');
    await flush();
    expect(calls).toEqual([]);
    expect(lastSpoken(rendered)).toContain('no connection');
  });
});

describe('a dose recorded with no signal (DEV-071, DEC-140)', () => {
  const RULES: readonly ScriptedRule[] = [
    {
      whenSaid: /took/,
      then: {
        kind: 'CALL',
        name: 'record_dose',
        arguments: { itemId: ITEM, eventKind: 'TAKEN' },
      },
    },
  ];

  /** Say it, agree to it, and let both the request and the journal settle. */
  async function recordAndConfirm(rendered: Rendered): Promise<void> {
    press(rendered, 'say');
    await flush();
    press(rendered, 'confirm');
    await flush();
  }

  it('goes into the same journal the dose sheet uses, under the key the attempt spent', async () => {
    // The whole of DEC-140: voice adds no sync mechanism, it reaches the one that exists. The
    // entity type, the mutation and the key are the ones `PendingSenders` already knows how to
    // put on the wire and `OFF-6`/`OFF-7` already measure on hardware.
    const calls: string[] = [];
    const queued: string[] = [];
    const rendered = mount({
      script: 'i took it',
      rules: RULES,
      calls,
      moves: [],
      doseOutcome: { kind: 'OFFLINE' },
      journal: recordingJournal(queued),
    });

    await recordAndConfirm(rendered);

    expect(calls).toEqual(['recordDoseEvent:TAKEN:keyed']);
    expect(queued).toEqual([`dose_event:CREATE:${ITEM}:keyed`]);
  });

  it('says it kept it, which is a different promise from having recorded it', async () => {
    // Not "Done." `12` requires a queued change to be visible rather than assumed, and the two
    // sentences are two different promises - the shorter one would be telling somebody the server
    // has their record when the request has just failed.
    const rendered = mount({
      script: 'i took it',
      rules: RULES,
      calls: [],
      moves: [],
      doseOutcome: { kind: 'OFFLINE' },
      journal: recordingJournal([]),
    });

    await recordAndConfirm(rendered);

    expect(lastSpoken(rendered)).toContain('kept it here');
    expect(lastSpoken(rendered)).not.toContain('Done.');
  });

  it('says only that there is no connection when nothing would keep it', async () => {
    // `false` from the journal is a real answer: the store may not be open, or the device may have
    // no room (`19`'s low-storage scenario, `DEV-055`). A person told their dose was kept when
    // nothing kept it stops thinking about a record that does not exist, and there is no later
    // moment at which they find out - which is the failure `LOW-2` exists for.
    const rendered = mount({
      script: 'i took it',
      rules: RULES,
      calls: [],
      moves: [],
      doseOutcome: { kind: 'OFFLINE' },
      journal: recordingJournal([], false),
    });

    await recordAndConfirm(rendered);

    expect(lastSpoken(rendered)).toContain('no connection');
    expect(lastSpoken(rendered)).not.toContain('kept it here');
  });

  it('does not queue a dose the server answered and refused', async () => {
    // The other half of `DEV-071`, and the one that was quietly wrong: every failure was reported
    // as "no connection", so a caregiver whose grant had been revoked was told to try again later
    // - and a retry would be refused identically. A refusal is not a transport problem and must
    // never enter a journal that will replay it.
    const queued: string[] = [];
    const rendered = mount({
      script: 'i took it',
      rules: RULES,
      calls: [],
      moves: [],
      doseOutcome: { kind: 'UNAVAILABLE' },
      journal: recordingJournal(queued),
    });

    await recordAndConfirm(rendered);

    expect(queued).toEqual([]);
    expect(lastSpoken(rendered)).toContain('do not have access');
    expect(lastSpoken(rendered)).not.toContain('no connection');
  });

  it('still says "Done." when the server took it', async () => {
    // The control. Every assertion above is about a failure path, and a change that broke the
    // success path would satisfy all of them.
    const queued: string[] = [];
    const rendered = mount({
      script: 'i took it',
      rules: RULES,
      calls: [],
      moves: [],
      journal: recordingJournal(queued),
    });

    await recordAndConfirm(rendered);

    expect(queued).toEqual([]);
    expect(lastSpoken(rendered)).toContain('Done.');
  });
});
