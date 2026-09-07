/**
 * The Agent Tool Registry: every capability a conversational agent may name, with its conditions.
 *
 * Spec references: `17` (AI boundaries), `13`, `14`, `11`, `18`, `02`, `09`, `16`.
 * DEC-132, DEC-133.
 *
 * This is an **inventory of what already exists**, not a design for new behaviour. Each entry
 * corresponds to a `KynvioraClient` method or a navigation action a screen already performs, and
 * the dispatcher is the only thing that can run one.
 *
 * HOW TO READ THE `voice` COLUMN
 * `TOUCH_ONLY` does not mean "not built". It means a person cannot do this by speaking, and the
 * agent's job when asked is to say where the control is. Three groups are `TOUCH_ONLY` and each
 * for its own reason:
 *
 *  1. **Fresh identity is required** (`14`): the Visit Pack, the data export, caregiver
 *     administration, closing the account. Nothing in this build can re-authenticate by voice,
 *     and a spoken "yes" is a far weaker act than a typed password in a room with other people
 *     in it - which is the room an older adult using a voice interface is most likely to be in.
 *  2. **It removes a health record** (`16`, `docs/RETENTION.md`): deleting an item. The record is
 *     recoverable only for as long as the retention window, and a misheard word is a plausible
 *     way to lose one.
 *  3. **It is a legal act** (`16`): recording or withdrawing consent. A consent receipt is a
 *     versioned record that somebody read a specific text, and a voice interface cannot show
 *     somebody a text.
 *
 * WHAT IS DELIBERATELY ABSENT
 * There is no tool for prescribing, changing a dose, stopping, splitting, replacing or
 * recommending a medicine, because no such capability exists in Kynviora for a tool to name. The
 * absence is asserted by test rather than left to review.
 */

import { type ToolDefinition, type ToolName, TOOL_NAMES, isToolName } from './tools.js';

/**
 * The identifier of the profile a tool acts on.
 *
 * Every profile-scoped tool takes it, and it **narrows rather than grants** - `13`'s rule, and the
 * reason this is safe to let a model fill in. A profile ID the caller cannot see comes back as an
 * empty result, exactly as it does on the shelf.
 */
const PROFILE_ID = {
  name: 'profileId',
  type: 'string',
  required: true,
  description: 'Which person in the household this is about.',
} as const;

const ITEM_ID = {
  name: 'itemId',
  type: 'string',
  required: true,
  description: 'Which item on the shelf this is about.',
} as const;

const TOOLS: readonly ToolDefinition[] = Object.freeze([
  // ---------------------------------------------------------------------------
  // Reading the shelf
  // ---------------------------------------------------------------------------
  {
    name: 'list_medicines',
    description: 'List the medicines recorded for a person, with how well each one is known.',
    effect: 'READ',
    capability: 'VIEW_MEDICINES',
    confirmation: 'NONE',
    stepUp: false,
    voice: 'ALLOWED',
    // The shelf is one of the things `03` group J requires with no signal, so this answers from
    // the projection - marked stale, never as though it were fresh (DEC-100).
    offline: 'LOCAL_PROJECTION',
    surface: 'SHELF',
    parameters: [PROFILE_ID],
    blockedBy: null,
  },
  {
    name: 'list_personal_care',
    description: 'List the personal-care products recorded for a person.',
    effect: 'READ',
    capability: 'VIEW_PERSONAL_CARE',
    confirmation: 'NONE',
    stepUp: false,
    voice: 'ALLOWED',
    offline: 'LOCAL_PROJECTION',
    surface: 'SHELF',
    parameters: [PROFILE_ID],
    blockedBy: null,
  },
  {
    name: 'describe_item',
    description: 'Read out what is recorded for one item, and what is not.',
    effect: 'READ',
    capability: 'VIEW_MEDICINES',
    confirmation: 'NONE',
    stepUp: false,
    voice: 'ALLOWED',
    offline: 'LOCAL_PROJECTION',
    surface: 'ITEM_DETAIL',
    parameters: [ITEM_ID],
    blockedBy: null,
  },
  {
    name: 'explain_what_is_missing',
    description:
      'Say what Kynviora still needs for an item before it can say more about it, and what would settle each thing.',
    effect: 'READ',
    capability: 'VIEW_MEDICINES',
    confirmation: 'NONE',
    stepUp: false,
    voice: 'ALLOWED',
    offline: 'LOCAL_PROJECTION',
    surface: 'ITEM_DETAIL',
    parameters: [ITEM_ID],
    blockedBy: null,
  },

  // ---------------------------------------------------------------------------
  // Medicines and doses
  // ---------------------------------------------------------------------------
  {
    name: 'list_schedules',
    description: 'Say when a medicine is set to be taken.',
    effect: 'READ',
    capability: 'VIEW_MEDICINES',
    confirmation: 'NONE',
    stepUp: false,
    voice: 'ALLOWED',
    offline: 'LOCAL_PROJECTION',
    surface: 'SCHEDULE_SHEET',
    parameters: [ITEM_ID],
    blockedBy: null,
  },
  {
    name: 'read_dose_history',
    description: 'Read back what was recorded about a medicine. No counts, rates or streaks.',
    effect: 'READ',
    capability: 'VIEW_MEDICINES',
    confirmation: 'NONE',
    stepUp: false,
    voice: 'ALLOWED',
    offline: 'LOCAL_PROJECTION',
    surface: 'DOSE_SHEET',
    parameters: [ITEM_ID],
    blockedBy: null,
  },
  {
    name: 'record_dose',
    description: 'Record that a dose was taken, skipped, put off for now, or could not be taken.',
    effect: 'WRITE',
    // Its own capability since DEC-116, and no existing grant acquired it.
    capability: 'RECORD_DOSES',
    confirmation: 'EXPLICIT',
    stepUp: false,
    voice: 'ALLOWED',
    // The one write a phone can make with no signal (`12`, DEC-111). The key is minted once per
    // intent, so a replay lands once.
    offline: 'QUEUES',
    surface: 'DOSE_SHEET',
    parameters: [
      ITEM_ID,
      {
        name: 'eventKind',
        type: 'enum',
        required: true,
        description: 'What happened.',
        // `DOSE_EVENT_KINDS` verbatim. Written out rather than imported so this file stays a
        // declaration a provider can be handed - but it is the domain's list, and
        // `registry.test.ts` asserts the two have not drifted. Inventing a fifth member here
        // would be a tool proposing a dose event the database has a CHECK against.
        values: ['TAKEN', 'SKIPPED', 'SNOOZED', 'UNABLE_TO_TAKE'],
      },
      {
        name: 'note',
        type: 'string',
        required: false,
        description: "The person's own words about this dose, recorded verbatim.",
      },
    ],
    blockedBy: null,
  },
  {
    name: 'create_schedule',
    description: 'Set the times a medicine is to be taken, as the person states them.',
    effect: 'WRITE',
    capability: 'MANAGE_MEDICINES',
    confirmation: 'EXPLICIT',
    stepUp: false,
    voice: 'ALLOWED',
    // See `update_schedule` below: only `record_dose` reaches the journal, so this is the value
    // that describes the build rather than an intention (`DEV-084`).
    offline: 'ONLINE_ONLY',
    surface: 'SCHEDULE_SHEET',
    parameters: [
      ITEM_ID,
      {
        name: 'timesOfDay',
        type: 'string',
        required: true,
        description: 'Local times of day, 24-hour, comma separated. For example "08:00,20:00".',
      },
      {
        name: 'timeZone',
        type: 'string',
        required: true,
        description:
          'The IANA zone the times are stated in. A schedule authored for somewhere else is why this is not assumed.',
      },
    ],
    blockedBy: null,
  },
  {
    name: 'update_schedule',
    description: 'Change the times a medicine is to be taken, or stop the schedule.',
    effect: 'WRITE',
    capability: 'MANAGE_MEDICINES',
    confirmation: 'EXPLICIT',
    stepUp: false,
    voice: 'ALLOWED',
    // `ONLINE_ONLY`, and it used to say `QUEUES`. Only `record_dose` reaches the offline journal
    // (DEC-140); nothing queues a schedule change by voice, and a change conditional on
    // `expectedVersion` is not something a replay can carry unchanged anyway. Declaring `QUEUES`
    // meant gate 5 let it through with no connection, so the write failed and the person was told
    // it had failed - honest since `DEV-085`, but a round trip to say what the gate already knew.
    // Refusing early is the same answer, sooner, and the registry now describes the build
    // (`DEV-084`).
    offline: 'ONLINE_ONLY',
    surface: 'SCHEDULE_SHEET',
    parameters: [
      // The item as well as the schedule. `ScheduleChangeBody` is whole-document and conditional
      // on `expectedVersion`, and no client method reads one schedule by its own ID - so the row
      // has to be found through `schedules(itemId)`. The agent has it: a `scheduleId` can only
      // have come from `list_schedules`, which takes an `itemId`.
      ITEM_ID,
      { name: 'scheduleId', type: 'string', required: true, description: 'Which schedule.' },
      {
        name: 'timesOfDay',
        type: 'string',
        required: false,
        description: 'The new local times, 24-hour, comma separated.',
      },
      {
        name: 'active',
        type: 'boolean',
        required: false,
        description: 'False stops the schedule without deleting what was recorded.',
      },
    ],
    blockedBy: null,
  },

  // ---------------------------------------------------------------------------
  // Adding and correcting
  // ---------------------------------------------------------------------------
  {
    name: 'add_medicine',
    description: 'Write down a medicine the person names. Nothing is looked up or guessed.',
    effect: 'WRITE',
    capability: 'MANAGE_MEDICINES',
    confirmation: 'EXPLICIT',
    stepUp: false,
    voice: 'ALLOWED',
    offline: 'ONLINE_ONLY',
    surface: 'ADD_ITEM_SHEET',
    parameters: [
      PROFILE_ID,
      {
        name: 'displayName',
        type: 'string',
        required: true,
        description: 'What the person calls it. Recorded as spoken, never corrected or expanded.',
      },
      {
        name: 'strengthText',
        type: 'string',
        required: false,
        description: 'The strength as printed, if the person states one. Never inferred.',
      },
      {
        name: 'dosageForm',
        type: 'string',
        required: false,
        description: 'Tablet, capsule, liquid and so on, if the person states one.',
      },
    ],
    blockedBy: null,
  },
  {
    name: 'add_personal_care_item',
    description: 'Write down a personal-care product the person names.',
    effect: 'WRITE',
    capability: 'MANAGE_PERSONAL_CARE',
    confirmation: 'EXPLICIT',
    stepUp: false,
    voice: 'ALLOWED',
    offline: 'ONLINE_ONLY',
    surface: 'ADD_ITEM_SHEET',
    parameters: [
      PROFILE_ID,
      { name: 'displayName', type: 'string', required: true, description: 'What it is called.' },
      {
        name: 'personalCareCategory',
        type: 'enum',
        required: true,
        description: 'Which category it belongs to.',
        values: [
          'SKIN_CARE',
          'SUNSCREEN',
          'HAIR_CARE',
          'BODY_WASH',
          'ORAL_CARE',
          'COSMETIC_TOPICAL',
        ],
      },
    ],
    blockedBy: null,
  },
  {
    name: 'update_item',
    description: 'Correct what is recorded about an item.',
    effect: 'WRITE',
    capability: 'MANAGE_MEDICINES',
    confirmation: 'EXPLICIT',
    stepUp: false,
    voice: 'ALLOWED',
    offline: 'ONLINE_ONLY',
    surface: 'ITEM_DETAIL',
    parameters: [
      ITEM_ID,
      {
        name: 'field',
        type: 'enum',
        required: true,
        description: 'Which recorded field to correct.',
        values: ['displayName', 'brand', 'strengthText', 'dosageForm', 'notes', 'expiresOn'],
      },
      { name: 'value', type: 'string', required: true, description: 'The corrected value.' },
    ],
    blockedBy: null,
  },
  {
    name: 'delete_item',
    description: 'Remove an item from the shelf.',
    effect: 'WRITE',
    // No caregiver capability authorises deletion at any level (docs/RETENTION.md section 2).
    capability: 'OWNER_ONLY',
    confirmation: 'EXPLICIT',
    stepUp: false,
    // Group 2. Removing a health record on a misheard word is a loss with a deadline on its
    // recovery, and the control is three taps away on a screen that says what it will do.
    voice: 'TOUCH_ONLY',
    offline: 'ONLINE_ONLY',
    surface: 'ITEM_DETAIL',
    parameters: [ITEM_ID],
    blockedBy: null,
  },

  // ---------------------------------------------------------------------------
  // Safety
  // ---------------------------------------------------------------------------
  {
    name: 'list_safety_state',
    description:
      'Say what Kynviora is and is not watching for a person, item by item. An absence of a matched rule is never read out as approval.',
    effect: 'READ',
    capability: 'VIEW_ALERTS',
    confirmation: 'NONE',
    stepUp: false,
    voice: 'ALLOWED',
    offline: 'LOCAL_PROJECTION',
    surface: 'SAFETY',
    parameters: [PROFILE_ID],
    blockedBy: null,
  },
  {
    name: 'describe_alert',
    description:
      'Read a published alert: what changed, how exactly it matches, the source and date, the limits, and the bounded next step.',
    effect: 'READ',
    capability: 'VIEW_ALERTS',
    confirmation: 'NONE',
    stepUp: false,
    voice: 'ALLOWED',
    offline: 'LOCAL_PROJECTION',
    surface: 'SAFETY',
    parameters: [{ name: 'alertId', type: 'string', required: true, description: 'Which alert.' }],
    blockedBy: null,
  },

  // ---------------------------------------------------------------------------
  // Household and care
  // ---------------------------------------------------------------------------
  {
    name: 'list_people',
    description: 'Say who is in this household.',
    effect: 'READ',
    capability: 'NONE',
    confirmation: 'NONE',
    stepUp: false,
    voice: 'ALLOWED',
    offline: 'LOCAL_PROJECTION',
    surface: 'CARE',
    parameters: [],
    blockedBy: null,
  },
  {
    name: 'list_caregiver_access',
    description: 'Say who has been given access to a person, and what each of them may do.',
    effect: 'READ',
    capability: 'OWNER_ONLY',
    confirmation: 'NONE',
    stepUp: false,
    voice: 'ALLOWED',
    offline: 'ONLINE_ONLY',
    surface: 'CARE',
    parameters: [PROFILE_ID],
    blockedBy: null,
  },
  {
    name: 'invite_caregiver',
    description: 'Give somebody access to a person. Say where the control is; do not perform it.',
    effect: 'WRITE',
    capability: 'OWNER_ONLY',
    confirmation: 'EXPLICIT',
    // `14` puts caregiver administration behind a fresh identity confirmation.
    stepUp: true,
    voice: 'TOUCH_ONLY',
    offline: 'ONLINE_ONLY',
    surface: 'CARE',
    parameters: [PROFILE_ID],
    blockedBy: null,
  },
  {
    name: 'revoke_caregiver_access',
    description: 'Take away somebody access. Say where the control is; do not perform it.',
    effect: 'WRITE',
    capability: 'OWNER_ONLY',
    confirmation: 'EXPLICIT',
    stepUp: true,
    voice: 'TOUCH_ONLY',
    offline: 'ONLINE_ONLY',
    surface: 'CARE',
    parameters: [{ name: 'grantId', type: 'string', required: true, description: 'Which grant.' }],
    blockedBy: null,
  },

  // ---------------------------------------------------------------------------
  // Sharing and account
  // ---------------------------------------------------------------------------
  {
    name: 'prepare_visit_pack',
    description:
      'Prepare a summary to share with a health professional. Say where it is; do not choose what goes in it.',
    effect: 'WRITE',
    capability: 'OWNER_ONLY',
    confirmation: 'EXPLICIT',
    stepUp: true,
    // Group 1, and the sharpest case: `16` rests the whole export on the promise that nothing is
    // included until the person chooses it, one item at a time, on a screen. That promise cannot
    // be kept by reading a list aloud.
    voice: 'TOUCH_ONLY',
    offline: 'ONLINE_ONLY',
    surface: 'TODAY',
    parameters: [PROFILE_ID],
    blockedBy: null,
  },
  {
    name: 'export_my_data',
    description: 'Produce a copy of everything on this account. Say where the control is.',
    effect: 'WRITE',
    capability: 'OWNER_ONLY',
    confirmation: 'EXPLICIT',
    stepUp: true,
    voice: 'TOUCH_ONLY',
    offline: 'ONLINE_ONLY',
    surface: 'YOU',
    parameters: [],
    blockedBy: null,
  },
  {
    name: 'record_consent',
    description: 'Record or withdraw agreement to a purpose. Say where the control is.',
    effect: 'WRITE',
    capability: 'OWNER_ONLY',
    confirmation: 'EXPLICIT',
    stepUp: false,
    // Group 3. A consent receipt records that somebody read a **specific versioned text**, and a
    // voice interface cannot show anybody a text.
    voice: 'TOUCH_ONLY',
    offline: 'ONLINE_ONLY',
    surface: 'YOU',
    parameters: [
      { name: 'purpose', type: 'string', required: true, description: 'Which purpose.' },
      { name: 'granted', type: 'boolean', required: true, description: 'Agreed, or withdrawn.' },
    ],
    blockedBy: null,
  },
  {
    name: 'delete_account',
    description: 'Close the account and remove its data. Say where the control is.',
    effect: 'WRITE',
    capability: 'OWNER_ONLY',
    confirmation: 'EXPLICIT',
    stepUp: true,
    voice: 'TOUCH_ONLY',
    offline: 'ONLINE_ONLY',
    surface: 'YOU',
    parameters: [],
    blockedBy: null,
  },

  // ---------------------------------------------------------------------------
  // Getting around, and the camera
  // ---------------------------------------------------------------------------
  {
    name: 'open_screen',
    description: 'Move to one of the five destinations.',
    effect: 'NAVIGATE',
    capability: 'NONE',
    confirmation: 'NONE',
    stepUp: false,
    voice: 'ALLOWED',
    // Navigation needs nothing. A person with no signal can still be shown where they are.
    offline: 'LOCAL_PROJECTION',
    surface: 'NONE',
    parameters: [
      {
        name: 'screen',
        type: 'enum',
        required: true,
        description: 'Which destination.',
        values: ['TODAY', 'SHELF', 'SAFETY', 'CARE', 'YOU'],
      },
    ],
    blockedBy: null,
  },
  {
    name: 'open_item',
    description: "Open one item's own screen.",
    effect: 'NAVIGATE',
    capability: 'VIEW_MEDICINES',
    confirmation: 'NONE',
    stepUp: false,
    voice: 'ALLOWED',
    offline: 'LOCAL_PROJECTION',
    surface: 'ITEM_DETAIL',
    parameters: [ITEM_ID],
    blockedBy: null,
  },
  {
    name: 'start_package_capture',
    description:
      'Open the camera and begin guiding the person through photographing a package: front, back, and the ingredient panel.',
    effect: 'DEVICE',
    capability: 'MANAGE_MEDICINES',
    // Opening a camera changes nothing, and it points a lens at somebody's home. `16` treats a
    // capture as a deliberate act, so it is confirmed even though it writes nothing.
    confirmation: 'EXPLICIT',
    stepUp: false,
    voice: 'ALLOWED',
    offline: 'ONLINE_ONLY',
    surface: 'CAMERA',
    parameters: [
      PROFILE_ID,
      {
        name: 'panel',
        type: 'enum',
        required: true,
        description: 'Which panel to guide first.',
        values: ['FRONT', 'BACK', 'INGREDIENTS', 'BATCH_AND_EXPIRY'],
      },
    ],
    blockedBy: null,
  },
  {
    name: 'capture_next_package_photo',
    description:
      'Take the photo the person has been guided into framing, and move to the next panel.',
    effect: 'DEVICE',
    capability: 'MANAGE_MEDICINES',
    confirmation: 'NONE',
    stepUp: false,
    voice: 'ALLOWED',
    offline: 'ONLINE_ONLY',
    surface: 'CAMERA',
    parameters: [],
    blockedBy: null,
  },
  {
    name: 'read_extracted_fields',
    description:
      'Read back the fields extraction proposed from the photographs, each with where it came from and how certain it is.',
    effect: 'READ',
    capability: 'MANAGE_MEDICINES',
    confirmation: 'NONE',
    stepUp: false,
    voice: 'ALLOWED',
    offline: 'ONLINE_ONLY',
    surface: 'ADD_ITEM_SHEET',
    parameters: [],
    // There is no extraction provider, so there are no proposed fields (`17` requires dual
    // extraction and neither engine is credentialed). Listed rather than omitted so the agent can
    // say what it cannot do; refused by the dispatcher with this identifier attached.
    blockedBy: 'BLK-007',
  },
  {
    name: 'confirm_extracted_item',
    description:
      'Create the item from fields the person has confirmed one by one. Nothing unconfirmed is ever written.',
    effect: 'WRITE',
    capability: 'MANAGE_MEDICINES',
    confirmation: 'EXPLICIT',
    stepUp: false,
    voice: 'ALLOWED',
    offline: 'ONLINE_ONLY',
    surface: 'ADD_ITEM_SHEET',
    parameters: [],
    blockedBy: 'BLK-007',
  },

  // ---------------------------------------------------------------------------
  // The queue
  // ---------------------------------------------------------------------------
  {
    name: 'list_pending_changes',
    description: 'Say what is waiting on this phone to be sent, and what is waiting on the person.',
    effect: 'READ',
    capability: 'NONE',
    confirmation: 'NONE',
    stepUp: false,
    voice: 'ALLOWED',
    offline: 'LOCAL_PROJECTION',
    surface: 'PENDING_QUEUE',
    parameters: [],
    blockedBy: null,
  },
]);

const BY_NAME: ReadonlyMap<ToolName, ToolDefinition> = new Map(
  TOOLS.map((tool) => [tool.name, tool]),
);

/** Every tool, in registry order. */
export function allTools(): readonly ToolDefinition[] {
  return TOOLS;
}

/** One tool by name, or `null` where the name is not one. */
export function toolNamed(name: string): ToolDefinition | null {
  return isToolName(name) ? (BY_NAME.get(name) ?? null) : null;
}

/**
 * The tools an agent operating by voice may be told about.
 *
 * A `TOUCH_ONLY` tool is **not** in this list, which is the second of the two mechanisms that
 * keep it out of reach: the agent is never told it exists as something to call, and the
 * dispatcher refuses it if a call arrives anyway. One of those alone is a policy; both of them is
 * a boundary.
 */
export function voiceCallableTools(): readonly ToolDefinition[] {
  return TOOLS.filter((tool) => tool.voice === 'ALLOWED');
}

/** Every tool whose provider does not exist, with the blocker that explains it. */
export function blockedTools(): readonly ToolDefinition[] {
  return TOOLS.filter((tool) => tool.blockedBy !== null);
}

/** Registry completeness, asserted rather than assumed. */
export function everyToolNameIsDefined(): boolean {
  return TOOL_NAMES.every((name) => BY_NAME.has(name));
}
