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
  type ApiOutcome,
  type DoseEventBody,
  type KynvioraClient,
  type ScheduleBody,
} from '@kynviora/contracts';
import { isDoseEventKind, type DoseEventKind } from '@kynviora/domain';
import type { ToolCall, ToolExecutor, UtteranceKey } from '@kynviora/agent';
import { newIdempotencyKey } from '@/platform/ids';

/** What every executor answers with: what to say, and what the screen should open. */
export interface ToolResult {
  /** Lines the Speech Gate will accept, because the presentation layer composed them. */
  readonly spoken: readonly string[];
  /**
   * Fixed sentences, named rather than written out.
   *
   * A key into the Speech Gate's closed set, which is a **different channel** from `spoken` and
   * exists to close a small hole in the first one. `spoken` is checked against `composedFrom`,
   * and the caller passes this file's own `spoken` array as `composedFrom` - so a string written
   * here would cite itself and pass. Every one of them happens to come from the presentation layer
   * today, and nothing was enforcing that.
   *
   * A key cannot cite itself: `gateSpeech` resolves it against `UTTERANCES` and refuses one this
   * build does not have. So a conversation's own sentences - "I have kept it here", "I cannot do
   * that by voice" - go through here, and only facts about somebody's records go through `spoken`.
   */
  readonly utterances?: readonly UtteranceKey[];
  /** An identifier the caller may need to open a surface - an item, a schedule. */
  readonly focusId?: string;
}

function argument(call: ToolCall, name: string): string {
  const value = call.arguments[name];
  return typeof value === 'string' ? value : '';
}

/**
 * What to say when a write reached the server and did not land.
 *
 * A total function over the failure kinds, so a kind added to `ApiOutcome` later is a compile
 * error here rather than a write silently acquiring somebody else's sentence. `OFFLINE` is absent
 * because it is not a failure of this kind at all - it is the one outcome that queues.
 */
function utteranceForWriteFailure(
  kind: Exclude<ApiOutcome<unknown>['kind'], 'OK' | 'OFFLINE'>,
): UtteranceKey {
  switch (kind) {
    case 'STEP_UP_REQUIRED':
      return 'needsIdentity';
    case 'UNAVAILABLE':
      // Never `notAllowed`. `13` makes absence and refused access indistinguishable on purpose.
      return 'notAvailable';
    case 'UNAUTHENTICATED':
    case 'AUTHORIZATION_LOST':
    case 'REFUSED':
    case 'SERVER_ERROR':
      return 'didNotGoThrough';
  }
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
  /**
   * Keep a dose no server could be reached about, answering whether it was kept.
   *
   * Takes the **body that was sent** and the key it was sent under rather than the call, because
   * the journal replays a request and not an intent: a queue built from the arguments again would
   * be a second reading of what the person said, taken minutes later, and a different reading is a
   * different dose. `13` resolves `dose_event` `MERGE_BY_ID`, so the replay under this key lands on
   * the row the failed attempt may already have written (DEC-111).
   *
   * `false` is a real answer and not a failure of this function: the store may not be open, or the
   * device may have no room for the write (`19`'s low-storage scenario, `DEV-055`). What must not
   * happen is a person being told their dose was kept when nothing kept it, which is the
   * distinction `OFF-6` measures on a device for the touch path.
   */
  queueDose: (body: DoseEventBody, idempotencyKey: string) => Promise<boolean>,
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

    /**
     * Record a dose, and keep it on the phone where no server could be reached (DEC-140).
     *
     * THE THREE ANSWERS, AND WHY THEY ARE THREE
     * This used to have two, and the missing one cost a dose. Every failure was reported as "this
     * phone has no connection", so a caregiver whose grant had been revoked was told to try again
     * later - and a person in a kitchen with no signal was told their record had not been made and
     * nothing kept it (`DEV-071`).
     *
     * `OFFLINE` is the only kind that means no server was reached. It is the one that queues, under
     * **the key the attempt already spent**: a fresh key would commit a second event where the
     * first request arrived and lost its answer, and on a dose history that is a false record of
     * what somebody did (DEC-111).
     *
     * Everything else is a server that answered and did not write. Saying "no connection" to that
     * is telling somebody to retry something that will fail identically, so each kind gets the
     * sentence that is true of it - and **none of them is `notAllowed`**. A `404` is the one to be
     * careful about: `13` makes absence and refused access deliberately indistinguishable, so
     * "you do not have access to that" would assert the reading the server declined to give. The
     * screen says "Kynviora has nothing to show here" for the same answer, and `notAvailable` is
     * that sentence in the conversation's register.
     *
     * `STEP_UP_REQUIRED` keeps its own sentence, which points at the screen where a password can
     * be typed. Everything else - a lost session, a refusal with a code, a server that failed -
     * says `didNotGoThrough`, whose second half is the half that matters: nothing was kept.
     */
    record_dose: async (call) => {
      // Minted once, here, for this intent. If the send fails the journal keeps **this** key, so
      // the replay lands once (DEC-111).
      const key = newIdempotencyKey();
      const body: DoseEventBody = {
        ownedItemId: argument(call, 'itemId'),
        // Narrowed rather than cast. The dispatcher has already refused anything that is not
        // one of the four, so this cannot fail - and a cast would be the one place a fifth kind
        // could reach a column with a CHECK against it.
        eventKind: asDoseEventKind(argument(call, 'eventKind')),
        ...(argument(call, 'note') === '' ? {} : { note: argument(call, 'note') }),
      };
      const outcome = await client.recordDoseEvent(body, key);
      if (outcome.kind === 'OK') return { spoken: [] } satisfies ToolResult;

      if (outcome.kind !== 'OFFLINE') {
        return { spoken: [], utterances: [utteranceForWriteFailure(outcome.kind)] };
      }

      // Not "Recorded." and not "Done." - those are promises about a server that has the record.
      // `queued` is the promise this can actually keep, and it is the same distinction the dose
      // sheet draws between "Recorded." and its offline note, which `OFF-6` measures on hardware.
      const kept = await queueDose(body, key);
      return { spoken: [], utterances: [kept ? 'queued' : 'offline'] } satisfies ToolResult;
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
      if (outcome.kind === 'OK') {
        return { spoken: [], focusId: argument(call, 'itemId') } satisfies ToolResult;
      }
      // A write that failed says so. This used to return an empty result for every outcome, and
      // `run` speaks "Done." when a tool says nothing at all - so a schedule that was never
      // created was reported as created. `offline` rather than `queued` because nothing here
      // queues: the registry declares this tool `QUEUES` and only `record_dose` is wired to the
      // journal, so the sentence that can be kept is the one that promises nothing (`DEV-085`).
      return {
        spoken: [],
        utterances: [
          outcome.kind === 'OFFLINE' ? 'offline' : utteranceForWriteFailure(outcome.kind),
        ],
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
      if (outcome.kind === 'OK') {
        // The server's own words about what it cannot yet do with this pack (DEC-010).
        return { spoken: outcome.value.limits, focusId: outcome.value.id } satisfies ToolResult;
      }
      // Said rather than swallowed. An item that was not created must not be reported as created
      // (`DEV-085`).
      return {
        spoken: [],
        utterances: [
          outcome.kind === 'OFFLINE' ? 'offline' : utteranceForWriteFailure(outcome.kind),
        ],
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
      if (outcome.kind === 'OK') {
        return { spoken: outcome.value.limits, focusId: outcome.value.id } satisfies ToolResult;
      }
      return {
        spoken: [],
        utterances: [
          outcome.kind === 'OFFLINE' ? 'offline' : utteranceForWriteFailure(outcome.kind),
        ],
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
