/**
 * What each tool actually does: the same client call the screen for it makes.
 *
 * Spec references: `17` (models get no write tools; the agent's reach is the app's reach), `13`
 * (idempotency; a profile ID narrows and never grants), `12` (the offline journal), `11`.
 * DEC-132.
 *
 * THE WHOLE POINT OF THIS FILE
 * Every function here calls a `KynvioraClient` method. There is no SQL, no token, no route
 * construction and no second authorization path - so a caller reaching a tool reaches exactly
 * what the screen for that tool reaches, on the same session, and row-level security, caregiver
 * capabilities and step-up all apply unchanged.
 *
 * SPOKEN LINES COME OUT OF THE PRESENTATION LAYER, NOT OUT OF HERE
 * Each result carries a `spoken` array, and every string in it was composed by `@kynviora/
 * presentation` or arrived composed from the server (DEC-010). The Speech Gate then refuses
 * anything that is not one of those strings, so this file cannot introduce a sentence about a
 * medicine even by accident - a string written here would be refused by the gate for the same
 * reason a model's would.
 *
 * THE ONE THING IT ADDS
 * Idempotency keys, minted **once per intent** (`platform/ids.ts`). A key regenerated on retry is
 * not an idempotency key, and on a schedule a second row is somebody being told twice, at the
 * same minute, to take the same tablet (DEC-111).
 */

import {
  doseHistory,
  itemDetailScreenView,
  shelfView,
  type KynvioraClient,
  type ScheduleBody,
} from '@kynviora/contracts';
import { isDoseEventKind, type DoseEventKind } from '@kynviora/domain';
import type { ToolCall, ToolExecutor } from '@kynviora/agent';
import { newIdempotencyKey } from '@/platform/ids';

/** What every executor answers with: what to say, and what the screen should open. */
export interface ToolResult {
  /** Lines the Speech Gate will accept, because the presentation layer composed them. */
  readonly spoken: readonly string[];
  /** An identifier the caller may need to open a surface - an item, a schedule. */
  readonly focusId?: string;
}

function argument(call: ToolCall, name: string): string {
  const value = call.arguments[name];
  return typeof value === 'string' ? value : '';
}

/**
 * The four the vocabulary has, and no fifth.
 *
 * The dispatcher has already refused anything else - the tool declares the enum and
 * `validateArguments` is strict about it - so this narrowing never actually rejects. It exists so
 * that a change to the registry's list which drifted from `DOSE_EVENT_KINDS` fails here rather
 * than at a database CHECK, where the person would see a 500 instead of a sentence.
 */
function asDoseEventKind(value: string): DoseEventKind {
  if (!isDoseEventKind(value)) {
    throw new TypeError(`Not a dose event kind: ${value}`);
  }
  return value;
}

/**
 * Where the app can be told to go.
 *
 * Supplied by the provider rather than imported, so this module stays testable in Node and so a
 * navigation call is a **function the app chose to expose** rather than a router this file
 * reached for. `12` puts platform behaviour behind an adapter and a router is platform behaviour.
 */
export interface VoiceBridge {
  openScreen(screen: string): void;
  openItem(itemId: string): void;
  openCamera(panel: string): void;
  captureNextPhoto(): void;
}

/**
 * Build the executor.
 *
 * A partial map on purpose. A tool with no entry is refused as `BLOCKED` by the dispatcher, which
 * is the honest answer for a capability this build has not wired - and never a crash inside a
 * conversation.
 */
export function createToolExecutor(
  client: KynvioraClient,
  bridge: VoiceBridge,
  /** Queue a dose the server could not be told about, returning the sentence to say. */
  queueDose: (call: ToolCall, idempotencyKey: string) => Promise<string>,
): ToolExecutor {
  return {
    list_medicines: async (call) => {
      const outcome = await client.listItems({
        profileId: argument(call, 'profileId'),
        itemKind: 'MEDICINE',
      });
      if (outcome.kind !== 'OK') return { spoken: [] } satisfies ToolResult;
      const view = shelfView(outcome.value.items, outcome.value.nextCursor ?? null);
      return {
        // The item's own name and its three status lines, exactly as the shelf renders them.
        // Reading out a name without the qualification beside it would be the summary card that
        // states a conclusion whose caveat lives two taps away.
        spoken: view.items.flatMap((item) => [item.displayName, item.identity.label]),
      } satisfies ToolResult;
    },

    list_personal_care: async (call) => {
      const outcome = await client.listItems({
        profileId: argument(call, 'profileId'),
        itemKind: 'PERSONAL_CARE',
      });
      if (outcome.kind !== 'OK') return { spoken: [] } satisfies ToolResult;
      const view = shelfView(outcome.value.items, outcome.value.nextCursor ?? null);
      return {
        spoken: view.items.flatMap((item) => [item.displayName, item.formulation.label]),
      } satisfies ToolResult;
    },

    describe_item: async (call) => {
      const itemId = argument(call, 'itemId');
      const outcome = await client.itemDetail(itemId);
      if (outcome.kind !== 'OK') return { spoken: [] } satisfies ToolResult;
      const view = itemDetailScreenView(outcome.value);
      return {
        spoken: [
          view.displayName,
          ...view.categoryFields.map(
            (field) => `${field.label}. ${field.value ?? field.absentNote ?? ''}`,
          ),
          view.verificationNote,
        ],
        focusId: itemId,
      } satisfies ToolResult;
    },

    explain_what_is_missing: async (call) => {
      const itemId = argument(call, 'itemId');
      const outcome = await client.itemDetail(itemId);
      if (outcome.kind !== 'OK') return { spoken: [] } satisfies ToolResult;
      const view = itemDetailScreenView(outcome.value);
      return {
        // Each reason with **its own next step attached**, which is the rule a limitation never
        // moves down a layer: read out separately they would arrive as a list of complaints.
        spoken:
          view.attention.reasons.length === 0
            ? [view.attention.settledNote ?? '']
            : view.attention.reasons.map((reason) => `${reason.label} ${reason.nextStep}`),
        focusId: itemId,
      } satisfies ToolResult;
    },

    list_schedules: async (call) => {
      const outcome = await client.schedules(argument(call, 'itemId'));
      if (outcome.kind !== 'OK') return { spoken: [] } satisfies ToolResult;
      return {
        spoken: outcome.value.schedules.map((schedule) => (schedule.timesLocal ?? []).join(', ')),
        focusId: argument(call, 'itemId'),
      } satisfies ToolResult;
    },

    read_dose_history: async (call) => {
      const outcome = await client.doseEvents({ ownedItemId: argument(call, 'itemId') });
      if (outcome.kind !== 'OK') return { spoken: [] } satisfies ToolResult;
      // `doseHistory` returns no count, rate or streak, so there is nothing here to read out that
      // could become one even by accident (`02`, `04` Phase 4.3).
      const history = doseHistory(outcome.value.events);
      return {
        spoken:
          history.lines.length === 0
            ? [history.emptyMessage]
            : history.lines.map((line) => `${line.presentation.label} ${line.recordedOn}`),
        focusId: argument(call, 'itemId'),
      } satisfies ToolResult;
    },

    record_dose: async (call) => {
      // Minted once, here, for this intent. If the send fails the journal keeps **this** key, so
      // the replay lands once (DEC-111).
      const key = newIdempotencyKey();
      const outcome = await client.recordDoseEvent(
        {
          ownedItemId: argument(call, 'itemId'),
          // Narrowed rather than cast. The dispatcher has already refused anything that is not
          // one of the four, so this cannot fail - and a cast would be the one place a fifth kind
          // could reach a column with a CHECK against it.
          eventKind: asDoseEventKind(argument(call, 'eventKind')),
          ...(argument(call, 'note') === '' ? {} : { note: argument(call, 'note') }),
        },
        key,
      );
      if (outcome.kind === 'OK') return { spoken: [] } satisfies ToolResult;
      // Not "Recorded." - the two are different promises, and the shorter one would be telling
      // somebody the server has their record when the request has just failed.
      return { spoken: [await queueDose(call, key)] } satisfies ToolResult;
    },

    create_schedule: async (call) => {
      const times = argument(call, 'timesOfDay')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '');
      const body: ScheduleBody = {
        scheduleKind: 'FIXED_TIMES',
        timesLocal: times,
        timeZone: argument(call, 'timeZone'),
      };
      const outcome = await client.createSchedule(
        argument(call, 'itemId'),
        body,
        newIdempotencyKey(),
      );
      return {
        spoken: [],
        ...(outcome.kind === 'OK' ? { focusId: argument(call, 'itemId') } : {}),
      } satisfies ToolResult;
    },

    add_medicine: async (call) => {
      const outcome = await client.createItem(
        {
          profileId: argument(call, 'profileId'),
          itemKind: 'MEDICINE',
          // As spoken. Nothing is looked up, expanded or corrected, which is the whole promise of
          // manual entry (`08`: a typed record never becomes catalog truth).
          displayName: argument(call, 'displayName'),
          ...(argument(call, 'strengthText') === ''
            ? {}
            : { strengthText: argument(call, 'strengthText') }),
          ...(argument(call, 'dosageForm') === ''
            ? {}
            : { dosageForm: argument(call, 'dosageForm') }),
        },
        newIdempotencyKey(),
      );
      return {
        // The server's own words about what it cannot yet do with this pack (DEC-010).
        spoken: outcome.kind === 'OK' ? outcome.value.limits : [],
        ...(outcome.kind === 'OK' ? { focusId: outcome.value.id } : {}),
      } satisfies ToolResult;
    },

    add_personal_care_item: async (call) => {
      const outcome = await client.createItem(
        {
          profileId: argument(call, 'profileId'),
          itemKind: 'PERSONAL_CARE',
          displayName: argument(call, 'displayName'),
          personalCareCategory: argument(call, 'personalCareCategory'),
        },
        newIdempotencyKey(),
      );
      return {
        spoken: outcome.kind === 'OK' ? outcome.value.limits : [],
        ...(outcome.kind === 'OK' ? { focusId: outcome.value.id } : {}),
      } satisfies ToolResult;
    },

    list_people: async () => {
      const outcome = await client.listProfiles();
      if (outcome.kind !== 'OK') return { spoken: [] } satisfies ToolResult;
      return {
        spoken: outcome.value.profiles.map((profile) => profile.displayName),
      } satisfies ToolResult;
    },

    // Navigation writes nothing and asks the server nothing. It is here so that voice and touch
    // are one interface: somebody who stops listening carries on with their eyes.
    open_screen: (call) => {
      bridge.openScreen(argument(call, 'screen'));
      return Promise.resolve({ spoken: [] } satisfies ToolResult);
    },

    open_item: (call) => {
      bridge.openItem(argument(call, 'itemId'));
      return Promise.resolve({
        spoken: [],
        focusId: argument(call, 'itemId'),
      } satisfies ToolResult);
    },

    start_package_capture: (call) => {
      bridge.openCamera(argument(call, 'panel'));
      return Promise.resolve({ spoken: [] } satisfies ToolResult);
    },

    capture_next_package_photo: () => {
      bridge.captureNextPhoto();
      return Promise.resolve({ spoken: [] } satisfies ToolResult);
    },

    // `read_extracted_fields` and `confirm_extracted_item` have no entry, deliberately. There is
    // no extraction provider (`BLK-007`), so there are no proposed fields - and a stub answering
    // "nothing was read" would be indistinguishable, to the person and to a test, from an
    // extraction that ran and found nothing. The dispatcher refuses them with the blocker named.
  };
}
