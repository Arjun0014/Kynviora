/**
 * What a conversational agent is allowed to ask Kynviora to do, and under what conditions.
 *
 * Spec references: `17` (models propose; sources and validated records prove; rules and review
 * decide - and a model gets no publish or write tools), `13` (authority comes from the session,
 * never from a request), `14` (re-authentication for high-impact actions), `11` (the server
 * decides safety severity and caregiver authorization), `18` (confirmation and reversibility),
 * `02`, `09`. DEC-132, DEC-133.
 *
 * WHAT A TOOL IS, AND WHAT IT IS NOT
 * A tool is a **name for something a person can already do in this app**, with its arguments
 * typed and its conditions written down. It is not a new capability, not a new route, and not a
 * new authorization path. Every tool executes by calling the same `KynvioraClient` method a
 * screen calls, on the same session, so row-level security, caregiver capabilities, step-up and
 * the offline journal all apply exactly as they already do. **There is no tool that reaches the
 * database, and there is no tool that could be given one** - the dispatcher takes a client, and a
 * client is the only thing it can call.
 *
 * WHY EVERY FIELD IS REQUIRED
 * Six questions have to be answered before a capability can be spoken to: who may do it, does it
 * need confirming, does it need fresh proof of identity, may voice reach it at all, does it work
 * with no signal, and what does it put on the screen. None of them has a safe default - a default
 * is what somebody forgets to change - so the type demands all six and a new tool cannot compile
 * without an answer to each.
 *
 * THE RULES THAT ARE NOT IN THIS FILE
 * A tool cannot express "prescribe", "change the dose", "stop taking", "split", "replace" or
 * "recommend", because no such capability exists anywhere in Kynviora for it to be a name for.
 * That is the strongest form the rule can take: it is not a filter over the agent's output, it is
 * an absence in the vocabulary. `registry.test.ts` asserts the absence, so adding one would fail
 * a test rather than pass a review.
 */

/**
 * Every tool this build knows about.
 *
 * A closed union rather than a string, so a model that hallucinates a tool name is a lookup miss
 * rather than a dispatch. `17`'s "models propose" is exactly this: the proposal is checked against
 * a list somebody wrote.
 */
export const TOOL_NAMES = [
  // Reading the shelf
  'list_medicines',
  'list_personal_care',
  'describe_item',
  'explain_what_is_missing',
  // Medicines and doses
  'list_schedules',
  'read_dose_history',
  'record_dose',
  'create_schedule',
  'update_schedule',
  // Adding and correcting
  'add_medicine',
  'add_personal_care_item',
  'update_item',
  'delete_item',
  // Safety
  'list_safety_state',
  'describe_alert',
  // Household and care
  'list_people',
  'list_caregiver_access',
  'invite_caregiver',
  'revoke_caregiver_access',
  // Sharing and account
  'prepare_visit_pack',
  'export_my_data',
  'record_consent',
  'delete_account',
  // Getting around, and the camera
  'open_screen',
  'open_item',
  'start_package_capture',
  'capture_next_package_photo',
  'read_extracted_fields',
  'confirm_extracted_item',
  // The queue
  'list_pending_changes',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(value: unknown): value is ToolName {
  return typeof value === 'string' && (TOOL_NAMES as readonly string[]).includes(value);
}

/**
 * What a tool does to the world.
 *
 * `READ` returns what a screen would already show. `WRITE` changes a stored record. `NAVIGATE`
 * moves the person around the app and changes nothing. `DEVICE` asks the platform for something -
 * a camera, a permission - and changes nothing on its own.
 *
 * Separate from {@link ToolDefinition.confirmation} because they answer different questions: a
 * `NAVIGATE` needs no confirmation and a `WRITE` always does, but a `DEVICE` tool may need one
 * (opening a camera) without writing anything.
 */
export const TOOL_EFFECTS = ['READ', 'WRITE', 'NAVIGATE', 'DEVICE'] as const;
export type ToolEffect = (typeof TOOL_EFFECTS)[number];

/**
 * Whether the person has to say yes to the exact thing before it happens.
 *
 * `NONE` - nothing is changed and nothing leaves, so asking would be noise.
 * `EXPLICIT` - the summary of what is about to happen is spoken **and** shown, and the person has
 *   to confirm that summary. Not "yes" to an unstated thing: `18`'s rule about high-impact actions
 *   is that a person knows what they are agreeing to, and a voice interface is where that is
 *   easiest to lose.
 */
export const CONFIRMATION_MODES = ['NONE', 'EXPLICIT'] as const;
export type ConfirmationMode = (typeof CONFIRMATION_MODES)[number];

/**
 * Whether voice may reach this tool at all.
 *
 * `ALLOWED` - a person can ask for it out loud.
 * `TOUCH_ONLY` - it exists in the registry so the agent can **say where it is**, and the agent
 *   cannot invoke it. Deleting an account, changing who may see somebody's medicines, and sending
 *   a copy of a health record out of the app are in this group: `14` requires re-authentication
 *   for them, nothing in this build can re-authenticate by voice, and a spoken "yes" is a much
 *   weaker act than a typed password in a room with other people in it.
 */
export const VOICE_ACCESS = ['ALLOWED', 'TOUCH_ONLY'] as const;
export type VoiceAccess = (typeof VOICE_ACCESS)[number];

/**
 * What this tool does with no network.
 *
 * `ONLINE_ONLY` - it needs the server and says so rather than failing quietly.
 * `LOCAL_PROJECTION` - it can be answered from the last thing the server said, which arrives
 *   marked `STALE` and never as `READY` (DEC-100).
 * `QUEUES` - it is written into the offline journal and sent later, exactly once, under the
 *   idempotency key the first attempt minted (DEC-111).
 */
export const OFFLINE_BEHAVIOURS = ['ONLINE_ONLY', 'LOCAL_PROJECTION', 'QUEUES'] as const;
export type OfflineBehaviour = (typeof OFFLINE_BEHAVIOURS)[number];

/**
 * The screen a tool puts in front of the person.
 *
 * Voice and touch are one interface, not two. A tool that reads out a medicine also opens the
 * shelf, so somebody who stops listening can carry on with their eyes, and somebody who was not
 * listening can see what was said. `NONE` is for a tool whose result is entirely spoken and has
 * nowhere to be - there are deliberately very few.
 */
export const VISUAL_SURFACES = [
  'NONE',
  'TODAY',
  'SHELF',
  'ITEM_DETAIL',
  'SAFETY',
  'CARE',
  'YOU',
  'DOSE_SHEET',
  'SCHEDULE_SHEET',
  'ADD_ITEM_SHEET',
  'CAMERA',
  'PENDING_QUEUE',
] as const;
export type VisualSurface = (typeof VISUAL_SURFACES)[number];

/**
 * What the caller must hold for this tool to be permitted.
 *
 * **This is not the authorization.** The server decides, every time, on the session the request
 * carries - `11` and `13` put that decision there so no client can be it. This field is what
 * stops the agent *offering* something the write would refuse, which is the same reason the shelf
 * reads `mayRecordDoses` from the server rather than guessing (DEC-116). A tool whose capability
 * the caller does not hold is not in the list the agent is given, so it cannot be called; and if
 * one were, the route would refuse it anyway.
 *
 * `OWNER_ONLY` is for the things no caregiver capability grants at any level - deleting an item
 * or a profile, and everything about the account.
 */
export const TOOL_CAPABILITIES = [
  'NONE',
  'VIEW_MEDICINES',
  'VIEW_PERSONAL_CARE',
  'RECORD_DOSES',
  'MANAGE_MEDICINES',
  'MANAGE_PERSONAL_CARE',
  'VIEW_ALERTS',
  'OWNER_ONLY',
] as const;
export type ToolCapability = (typeof TOOL_CAPABILITIES)[number];

/** A tool parameter, described well enough to validate and to hand to a provider as a schema. */
export type ToolParameterType = 'string' | 'number' | 'boolean' | 'enum';

export interface ToolParameter {
  readonly name: string;
  readonly type: ToolParameterType;
  readonly required: boolean;
  /** What it means, in the words a provider would be shown. Never a value. */
  readonly description: string;
  /** For `enum`, the only accepted values. Ignored otherwise. */
  readonly values?: readonly string[];
}

/**
 * One capability, named, typed and conditioned.
 *
 * `blockedBy` is the honest field. A tool whose provider does not exist is **listed** - so the
 * agent can say what it cannot do and why, rather than pretending the capability is absent - and
 * the dispatcher refuses it with the blocker's own identifier. Extraction is the whole of this
 * group today (`BLK-003`, `BLK-007`), and inventing an answer for it is the exact failure `17`
 * exists to prevent.
 */
export interface ToolDefinition {
  readonly name: ToolName;
  /** One sentence, in the words a provider would be shown. */
  readonly description: string;
  readonly effect: ToolEffect;
  readonly capability: ToolCapability;
  readonly confirmation: ConfirmationMode;
  /** `14`: a fresh identity confirmation, not merely a live session. */
  readonly stepUp: boolean;
  readonly voice: VoiceAccess;
  readonly offline: OfflineBehaviour;
  readonly surface: VisualSurface;
  readonly parameters: readonly ToolParameter[];
  /** The blocker preventing this tool from doing anything, or `null` where it works. */
  readonly blockedBy: string | null;
}

/** A proposal from an agent: a name and some arguments, neither of them trusted yet. */
export interface ToolCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** Why a call was refused, as a code a caller branches on rather than a sentence. */
export const TOOL_REFUSALS = [
  /** The name is not in {@link TOOL_NAMES}. A hallucinated tool lands here. */
  'UNKNOWN_TOOL',
  /** A required argument is missing, or one has the wrong type or an unlisted enum value. */
  'INVALID_ARGUMENTS',
  /** An argument the tool does not declare. Strict, for the reason the API bodies are. */
  'UNEXPECTED_ARGUMENT',
  /** `voice: TOUCH_ONLY`, and the call came from voice. */
  'NOT_PERMITTED_BY_VOICE',
  /** The caller does not hold the capability, as the server last reported it. */
  'CAPABILITY_MISSING',
  /** `stepUp: true` and the session has no fresh confirmation. */
  'STEP_UP_REQUIRED',
  /** Confirmation is required and the person has not given it for **this** proposal. */
  'CONFIRMATION_REQUIRED',
  /** `ONLINE_ONLY` and there is no network. */
  'OFFLINE',
  /** The capability exists and its provider does not (`blockedBy`). */
  'BLOCKED',
] as const;
export type ToolRefusal = (typeof TOOL_REFUSALS)[number];

/**
 * The outcome of validating and dispatching one call.
 *
 * Closed, and a refusal carries the tool it was about where one was identified - so a caller can
 * say "I cannot change who sees your medicines by voice" rather than "no".
 */
export type ToolOutcome<T = unknown> =
  | { readonly kind: 'OK'; readonly tool: ToolDefinition; readonly value: T }
  | {
      readonly kind: 'REFUSED';
      readonly refusal: ToolRefusal;
      readonly tool: ToolDefinition | null;
      /** Which argument was at fault, where the refusal is about one. */
      readonly parameter?: string;
      /** The blocker's identifier, for `BLOCKED`. */
      readonly blocker?: string;
    };

/**
 * Narrow an argument bag against a tool's declared parameters.
 *
 * Hand-written rather than schema-driven, for the reason `parseWireError` is: this is untrusted
 * input - it may have come from a language model, which is a source `15` treats as hostile by
 * construction - and a validator that widened an unexpected shape would be the one place the
 * whole design leaks. Strict about extra keys, like the API bodies, so a model that invented a
 * `profileId` cannot smuggle one past a tool that does not take one.
 */
export function validateArguments(
  tool: ToolDefinition,
  args: Readonly<Record<string, unknown>>,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: ToolRefusal; readonly parameter: string } {
  const declared = new Set(tool.parameters.map((parameter) => parameter.name));
  for (const key of Object.keys(args)) {
    if (!declared.has(key)) return { ok: false, refusal: 'UNEXPECTED_ARGUMENT', parameter: key };
  }

  for (const parameter of tool.parameters) {
    const value = args[parameter.name];
    if (value === undefined || value === null) {
      if (parameter.required) {
        return { ok: false, refusal: 'INVALID_ARGUMENTS', parameter: parameter.name };
      }
      continue;
    }

    switch (parameter.type) {
      case 'string':
        // An empty string is a missing value wearing the right type, which is how a required
        // field gets past a check that only looked at `typeof`.
        if (typeof value !== 'string' || value.trim() === '') {
          return { ok: false, refusal: 'INVALID_ARGUMENTS', parameter: parameter.name };
        }
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return { ok: false, refusal: 'INVALID_ARGUMENTS', parameter: parameter.name };
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') {
          return { ok: false, refusal: 'INVALID_ARGUMENTS', parameter: parameter.name };
        }
        break;
      case 'enum':
        if (typeof value !== 'string' || !(parameter.values ?? []).includes(value)) {
          return { ok: false, refusal: 'INVALID_ARGUMENTS', parameter: parameter.name };
        }
        break;
    }
  }

  return { ok: true };
}
