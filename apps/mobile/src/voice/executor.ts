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
  alertDetailScreenView,
  caregiverAccessRows,
  doseHistory,
  itemDetailScreenView,
  safetyInboxView,
  shelfView,
  type ApiOutcome,
  type DoseEventBody,
  type ItemUpdateBody,
  type KynvioraClient,
  type ScheduleBody,
  type ScheduleChangeBody,
} from '@kynviora/contracts';
import {
  MAX_UPLOAD_ATTEMPTS,
  isDoseEventKind,
  type DoseEventKind,
  type PendingOperation,
} from '@kynviora/domain';
import { presentCaregiverAccess, pendingQueueView, summarizeAccess } from '@kynviora/presentation';
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
 * A display name that is really an identifier.
 *
 * `caregiverAccessRows` falls back to the grantee's user ID where the server sent no name, which
 * is right beside a control on a screen and wrong in a sentence somebody hears.
 */
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One corrected field, as a body the item route will accept - or `null`.
 *
 * A `switch` rather than `{ [field]: value }`, and the difference is the whole of DEC-146: the
 * field name is a string off a model completion, and computing a property name from one puts
 * whatever the model said into the request. Gate 3 has already refused anything outside the
 * registry's `values` list, so this never actually rejects - it is the same defence in depth
 * `summary.ts` carries, for the same reason. It also means a value added to the registry without
 * a case here is a compile error rather than a write that silently changes nothing.
 *
 * `expiresOn` and `notes` are nullable on the body: an empty spoken value clears them, which is
 * how somebody says "there is no expiry date on this one". The three text fields are not cleared
 * by an empty string, because `validateArguments` already refuses an empty required string.
 */
function itemUpdateFor(version: number, field: string, value: string): ItemUpdateBody | null {
  switch (field) {
    case 'displayName':
      return { expectedVersion: version, displayName: value };
    case 'brand':
      return { expectedVersion: version, brand: value };
    case 'strengthText':
      return { expectedVersion: version, strengthText: value };
    case 'dosageForm':
      return { expectedVersion: version, dosageForm: value };
    case 'notes':
      return { expectedVersion: version, notes: value };
    case 'expiresOn':
      return { expectedVersion: version, expiresOn: value };
    default:
      return null;
  }
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
/**
 * The writes this app can keep on the phone, and nothing else.
 *
 * Spec references: `12` (the pending-operation journal), `13` (the operation ID is the idempotency
 * key; per-entity conflict policy), DEC-140, DEC-148.
 *
 * WHY THESE TAKE THE BODY THAT WAS SENT
 * The journal replays a **request**, not an intent. A queue rebuilt from the tool call's arguments
 * would be a second reading of what somebody said, taken minutes later - and a different reading
 * is a different dose or a different time of day. So each of these takes the exact body the failed
 * attempt carried, and for a create the exact key it spent.
 *
 * WHY EACH ANSWERS A BOOLEAN
 * `false` is a real answer and not a failure of the call: the store may not be open, or the device
 * may have no room for the write (`19`'s low-storage scenario, `DEV-055`), or `13`'s per-entity
 * policy may refuse the type. What must not happen is a person being told a change was kept when
 * nothing kept it, which is the distinction `OFF-6` measures on a device for the touch path.
 *
 * WHY THERE IS NO `scheduleUpdate` THAT MINTS A VERSION
 * Because there is no honest way to mint one. See `update_schedule` below.
 */
export interface QueuedWrites {
  /**
   * A dose recorded with no signal, under the key the attempt already spent.
   *
   * `13` resolves `dose_event` `MERGE_BY_ID`, so the replay under this key lands on the row the
   * failed attempt may already have written (DEC-111).
   */
  dose(body: DoseEventBody, idempotencyKey: string): Promise<boolean>;
  /**
   * A schedule created with no signal, under the key the attempt already spent.
   *
   * The same reasoning as a dose and a sharper consequence: `OFFLINE` is inferred from a failed
   * fetch, which is also what a request that arrived and lost its answer looks like, and under a
   * fresh key the replay creates a **second schedule** - which on this table is somebody being
   * told twice, at the same minute, to take the same tablet (DEC-111).
   */
  scheduleCreate(itemId: string, body: ScheduleBody, idempotencyKey: string): Promise<boolean>;
  /**
   * A schedule change with no signal, conditional on the version it was made against.
   *
   * No idempotency key, and that is not an omission: a conditional write is already exactly-once
   * for its intent, so a replay either lands once or comes back as a `VERSION_CONFLICT` the person
   * is asked about (`13`'s `ASK_USER` for `medicine_schedule`).
   */
  scheduleUpdate(scheduleId: string, body: ScheduleChangeBody): Promise<boolean>;
}

export function createToolExecutor(
  client: KynvioraClient,
  bridge: VoiceBridge,
  /**
   * How a write that reached no server is kept on this phone.
   *
   * The same journal the screens use, reached through the same `usePendingSync().queue` - so the
   * drain, `13`'s per-entity policy, the retry budget and `PendingSenders`' wire call are all the
   * ones `OFF-1` to `OFF-7` already measure on hardware. Voice adds no sync mechanism; it reaches
   * the one that exists (DEC-132 applied to the offline path).
   */
  queued: QueuedWrites,
  /**
   * Everything the offline journal is holding.
   *
   * The journal rather than the client, because `list_pending_changes` asks a question about this
   * phone. `PendingSyncProvider.list` is the same function the queue screen calls, so voice and
   * touch read one journal rather than two answers about it.
   */
  listPending: () => Promise<readonly PendingOperation[]>,
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
      const kept = await queued.dose(body, key);
      return { spoken: [], utterances: [kept ? 'queued' : 'offline'] } satisfies ToolResult;
    },

    /**
     * Set the times a medicine is taken, and keep it on the phone where no server was reached.
     *
     * The key is minted **once, here, for this intent**, exactly as `record_dose` mints its own -
     * and the journal keeps that key rather than a fresh one. `OFFLINE` is inferred from a failed
     * fetch, which is also what a request that arrived and lost its answer looks like, so a fresh
     * key on the replay would create a second schedule: two reminders, at the same minute, for the
     * same tablet (DEC-111). `OFF-4` measures exactly that on hardware for the touch path.
     *
     * Three answers, for the reason `record_dose` has three. `OFFLINE` is the only kind that means
     * no server was reached and the only one that queues; everything else is a server that
     * answered and did not write, and telling somebody with a revoked grant that their phone has
     * no connection is telling them to retry something that will fail identically (`DEV-085`).
     *
     * No `focusId` on the queued branch, and that is deliberate rather than an omission. The
     * schedule sheet reads from the server; opening it with no connection would put "No
     * connection" in front of somebody who has just been told their change is safely kept.
     */
    create_schedule: async (call) => {
      const itemId = argument(call, 'itemId');
      const key = newIdempotencyKey();
      const times = argument(call, 'timesOfDay')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '');
      const body: ScheduleBody = {
        scheduleKind: 'FIXED_TIMES',
        timesLocal: times,
        timeZone: argument(call, 'timeZone'),
      };
      const outcome = await client.createSchedule(itemId, body, key);
      if (outcome.kind === 'OK') {
        return { spoken: [], focusId: itemId } satisfies ToolResult;
      }
      if (outcome.kind !== 'OFFLINE') {
        return {
          spoken: [],
          utterances: [utteranceForWriteFailure(outcome.kind)],
        } satisfies ToolResult;
      }
      const kept = await queued.scheduleCreate(itemId, body, key);
      return { spoken: [], utterances: [kept ? 'queued' : 'offline'] } satisfies ToolResult;
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

    /**
     * The Safety shelf, read aloud.
     *
     * WHY THE COVERAGE STATEMENT IS NOT OPTIONAL HERE
     * `09` requires the coverage statement to accompany the result rather than be inferred from
     * its absence, and `23` D-014 is that an absence of a matched rule must never render as
     * approval. On a screen the statement is a card at the top (DEC-138). Spoken, there is no
     * "top" - a list read out as five "Nothing matched" lines and then stopping is exactly the
     * shelf-has-been-cleared reading the statement exists to prevent, and it is worse out loud
     * because nothing remains on screen to qualify it afterwards.
     *
     * So it is said **first**, before any line, and it comes out of `safetyInboxView` rather than
     * being written here - which is also what lets the Speech Gate pass it.
     */
    list_safety_state: async (call) => {
      // `safetyInbox`, which is what the Safety screen reads, and unfiltered: a filter is a thing
      // somebody chose on a screen, and applying one nobody asked for would be answering a
      // narrower question than the one that was spoken. `profileAlerts` is a different read with
      // a different shape - it carries live alert rows rather than a line per shelf item, so it
      // cannot answer "is there anything I should know", which is about every item.
      const outcome = await client.safetyInbox(argument(call, 'profileId'));
      if (outcome.kind !== 'OK') return { spoken: [] } satisfies ToolResult;
      const view = safetyInboxView(outcome.value);
      return {
        spoken: [
          view.coverageStatement,
          // Name and state together, never a count and never a ranking (`02`): "three need
          // attention" is the aggregate score this app refuses to produce, and a sorted list is
          // that score with the number left off.
          ...view.lines.flatMap((line) => [line.displayName, line.state.label]),
        ],
      } satisfies ToolResult;
    },

    /**
     * One alert, with its two dimensions kept apart.
     *
     * `23` D-005 forbids merging evidence level and action urgency, and Phase 7.1 requires them
     * visibly separate. Spoken, "separate" means two sentences: they are read as their own labels
     * rather than joined into one phrase, because a single "high priority, strong evidence" is
     * the merged judgement the rule is about.
     */
    describe_alert: async (call) => {
      const alertId = argument(call, 'alertId');
      const outcome = await client.alertDetail(alertId);
      if (outcome.kind !== 'OK') return { spoken: [] } satisfies ToolResult;
      const view = alertDetailScreenView(outcome.value);
      return {
        spoken: [
          ...(view.withdrawnNotice === null ? [] : [view.withdrawnNotice]),
          ...(view.message ?? []),
          ...(view.unexplainable === null ? [] : [view.unexplainable.body]),
          ...(view.urgency === null ? [] : [view.urgency.label]),
          ...(view.evidence === null ? [] : [view.evidence.label]),
          view.source.summary,
          view.coverageStatement,
          ...(view.withheldNotice === null ? [] : [view.withheldNotice]),
        ],
        focusId: alertId,
      } satisfies ToolResult;
    },

    /**
     * Who has access to this person, and what that access carries.
     *
     * `displayName` is the grantee as the server named them, and `caregiverAccessRows` falls back
     * to their user ID when no name was supplied. That fallback is right on a screen, where the
     * row is beside a control, and wrong out loud: reading a UUID aloud tells a person nothing and
     * puts an identifier into a room. So a row with no name is announced by its **state and what
     * it carries** instead, which is what the question is actually about.
     */
    list_caregiver_access: async (call) => {
      const profileId = argument(call, 'profileId');
      const outcome = await client.listCaregiverGrants({ profileId });
      if (outcome.kind !== 'OK') return { spoken: [] } satisfies ToolResult;
      const rows = caregiverAccessRows(outcome.value.grants);
      return {
        spoken: rows.flatMap((row) => {
          const named = row.displayName !== row.id && !UUID_LIKE.test(row.displayName);
          const summary = summarizeAccess(row.capabilities);
          return [
            named ? row.displayName : presentCaregiverAccess(row.state).label,
            ...(named ? [presentCaregiverAccess(row.state).label] : []),
            // The three blocks the invitation review uses, in the same order and the same words:
            // what they can see, what they can change, what is not shared (DEC-142).
            ...summary.viewing,
            ...summary.changing,
          ];
        }),
      } satisfies ToolResult;
    },

    /**
     * What this phone is still holding, in the words the queue screen uses.
     *
     * Reads the journal rather than the server, which is the whole point: the question "did my
     * change go through" is about the phone, and asking the server would answer a different one.
     * `12` requires a queued change to be visible rather than assumed.
     */
    list_pending_changes: async () => {
      const operations = await listPending();
      const view = pendingQueueView(
        operations.map((operation) => ({
          operationId: operation.operationId,
          entityType: operation.entityType,
          mutation: operation.mutation,
          state: operation.state,
          attemptCount: operation.attemptCount,
          maxAttempts: MAX_UPLOAD_ATTEMPTS,
        })),
      );
      return {
        // The summary first, then each row's what and why. `why` is never a code or a
        // correlation ID, which is the property that makes it safe to say out loud.
        spoken: [view.summary, ...view.rows.flatMap((row) => [row.what, row.why])],
      } satisfies ToolResult;
    },

    /**
     * Correct one recorded field, on the version that was read.
     *
     * TWO CALLS, AND WHY THE FIRST ONE IS NOT A RACE
     * `updateItem` is conditional on `expectedVersion` rather than carrying an idempotency key
     * (`13`'s `ASK_USER` policy for an item), so the version has to be read before the write. If
     * somebody else changes the item in between, the server refuses on the precondition and the
     * person is told it did not go through - which is the outcome the precondition exists to
     * produce, not a hole in it. A key would be a second answer to the same question.
     *
     * The field name comes off a model completion. It is `type: 'enum'` so gate 3 has already
     * refused anything outside the list, and it is mapped by a `switch` rather than by indexing
     * `ItemUpdateBody` with it - a plain index keyed by model output is DEC-146 exactly, and a
     * `switch` also makes a field added to the registry a compile error here rather than a silent
     * no-op write.
     */
    update_item: async (call) => {
      const itemId = argument(call, 'itemId');
      const current = await client.itemDetail(itemId);
      if (current.kind !== 'OK') {
        return {
          spoken: [],
          utterances: [
            current.kind === 'OFFLINE' ? 'offline' : utteranceForWriteFailure(current.kind),
          ],
        } satisfies ToolResult;
      }

      const body = itemUpdateFor(
        current.value.version,
        argument(call, 'field'),
        argument(call, 'value'),
      );
      if (body === null) return { spoken: [], utterances: ['notUnderstood'] } satisfies ToolResult;

      const outcome = await client.updateItem(itemId, body);
      if (outcome.kind === 'OK') return { spoken: [], focusId: itemId } satisfies ToolResult;
      return {
        spoken: [],
        utterances: [
          outcome.kind === 'OFFLINE' ? 'offline' : utteranceForWriteFailure(outcome.kind),
        ],
      } satisfies ToolResult;
    },

    /**
     * Change when a medicine is taken, or stop the schedule without deleting it.
     *
     * WHY THIS TAKES AN ITEM AS WELL AS A SCHEDULE
     * `ScheduleChangeBody` is whole-document - it repeats the kind, the times and the zone - and
     * is conditional on `expectedVersion`, and no client method reads one schedule by its own ID.
     * So the current row has to be found, and `schedules(itemId)` is the read that finds it. The
     * agent has the item already: a `scheduleId` can only have come from `list_schedules`, which
     * takes an `itemId`. Adding the parameter is what makes the tool executable rather than a
     * declaration (`DEV-084`).
     *
     * Absent `timesOfDay` leaves the times alone, and absent `active` leaves it running. Nothing
     * here deletes a row: `active: false` is how reminders stop, which is the distinction the
     * registry's own description draws.
     */
    /**
     * Change the times a medicine is taken, and keep it on the phone where the write did not land.
     *
     * THE READ IS WHAT DECIDES WHETHER THIS CAN QUEUE (DEC-148)
     * `ScheduleChangeBody` is whole-document and conditional on `expectedVersion`, and the one
     * copy of that number is a server read - schedules are not in the local projection, which
     * holds the profile list and the shelf and nothing else. So there are exactly two shapes here
     * and they get opposite answers:
     *
     *   - **The read failed.** There is no version, and the two ways to send an update without one
     *     are both refused by `13`. Unconditionally is a silent overwrite of a row that may have
     *     moved since - which for a medication schedule is somebody's reminder times replaced by a
     *     change made against a state nobody looked at. A guessed version is the same overwrite
     *     with a lottery in front of it. So nothing is queued, and the sentence promises nothing.
     *   - **The read landed and the write dropped.** The version is real, freshly read, and is the
     *     one the person's change was made against - which is exactly the precondition the touch
     *     path queues under, because the schedule sheet was populated by the same read. That
     *     queues, and a replay against a row that has since moved comes back as a
     *     `VERSION_CONFLICT` rather than as a win.
     *
     * No idempotency key. A conditional write is already exactly-once for its intent: the replay
     * either matches the version and lands once, or does not and is refused.
     */
    update_schedule: async (call) => {
      const itemId = argument(call, 'itemId');
      const scheduleId = argument(call, 'scheduleId');
      const current = await client.schedules(itemId);
      if (current.kind !== 'OK') {
        // Nothing is queued and nothing is promised. `offline` says only that the server could not
        // be asked, which is the whole of what is true when there is no version to be conditional
        // on - and it is the sentence that does not tell somebody their reminder has moved.
        return {
          spoken: [],
          utterances: [
            current.kind === 'OFFLINE' ? 'offline' : utteranceForWriteFailure(current.kind),
          ],
        } satisfies ToolResult;
      }

      const schedule = current.value.schedules.find((row) => row.id === scheduleId);
      // A schedule this item does not have. Not an error to report as a failure of the write -
      // nothing was attempted - and `13` makes absence and refused access the same answer, so
      // there is nothing to say beyond not having understood which schedule was meant.
      if (schedule === undefined) {
        return { spoken: [], utterances: ['notUnderstood'] } satisfies ToolResult;
      }

      const times = argument(call, 'timesOfDay')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '');
      const active = call.arguments['active'];

      const body: ScheduleChangeBody = {
        expectedVersion: schedule.version,
        scheduleKind: schedule.scheduleKind,
        timeZone: schedule.timeZone,
        timesLocal: times.length === 0 ? schedule.timesLocal : times,
        ...(schedule.daysOfWeek === null ? {} : { daysOfWeek: schedule.daysOfWeek }),
        ...(typeof active === 'boolean' ? { active } : {}),
      };

      const outcome = await client.updateSchedule(scheduleId, body);
      if (outcome.kind === 'OK') return { spoken: [], focusId: itemId } satisfies ToolResult;
      if (outcome.kind !== 'OFFLINE') {
        return {
          spoken: [],
          utterances: [utteranceForWriteFailure(outcome.kind)],
        } satisfies ToolResult;
      }
      const kept = await queued.scheduleUpdate(scheduleId, body);
      return { spoken: [], utterances: [kept ? 'queued' : 'offline'] } satisfies ToolResult;
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
