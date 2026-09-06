/**
 * The sentence somebody is asked to agree to, and the sentence they are told when it is refused.
 *
 * Spec references: `18` (a person knows what they are agreeing to; a refusal says what to do
 * next; familiar words first), `14`, `13` (clients branch on codes, never on message text), `17`.
 * DEC-134, DEC-135.
 *
 * WRITTEN HERE RATHER THAN BY THE AGENT
 * The confirmation summary is the whole of the consent. If a model wrote it, the person would be
 * agreeing to a model's description of a model's proposal, checked by nobody - and the failure
 * mode is not exotic: "shall I record that you took it" is one word away from "shall I record
 * that you skipped it", and both are fluent.
 *
 * So the summary is composed from the tool definition and the validated arguments, by this file.
 * The arguments have already been through `validateArguments`, so an enum is one of its listed
 * values and a string is non-empty - which is what makes it safe to put them in a sentence.
 *
 * THE ONE PLACE AN ARGUMENT IS QUOTED BACK
 * A free-text argument - a dose note, a medicine's name as spoken - is the person's own words and
 * is read back verbatim. That is the same rule the dose note and the ingredient declaration
 * already follow: this app does not tidy what somebody wrote about their own treatment.
 */

import type { ToolCall, ToolDefinition, ToolRefusal } from './tools.js';

/** A string argument, or `null` where there is none. Never a coerced number or object. */
function text(call: ToolCall, name: string): string | null {
  const value = call.arguments[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * What a recorded dose is called in a sentence.
 *
 * One phrase per member of `DOSE_EVENT_KINDS`, and they are the words the screen's own controls
 * use turned into the first person of a question - "I skipped it" becomes "that you skipped it".
 * A phrase invented here would be a summary describing an event by a name the record does not
 * carry.
 */
const DOSE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  TAKEN: 'that you took it',
  SKIPPED: 'that you skipped it',
  SNOOZED: 'that you have put it off for now',
  UNABLE_TO_TAKE: 'that you could not take it',
});

const SCREEN_WORDS: Readonly<Record<string, string>> = Object.freeze({
  TODAY: 'Today',
  SHELF: 'your shelf',
  SAFETY: 'Safety',
  CARE: 'Care',
  YOU: 'You',
});

const PANEL_WORDS: Readonly<Record<string, string>> = Object.freeze({
  FRONT: 'the front of the pack',
  BACK: 'the back of the pack',
  INGREDIENTS: 'the ingredients panel',
  BATCH_AND_EXPIRY: 'the batch number and expiry date',
});

/**
 * What is about to happen, in one sentence, for the person to agree to.
 *
 * `subjectLabel` is what the item or person is called, resolved by the caller from a tool result
 * rather than from the arguments - an ID read out loud is not a description of anything. Where
 * the caller has no label, the sentence says "this item", which is honest and is what a screen
 * showing the item alongside makes unambiguous.
 */
export function summariseProposal(
  tool: ToolDefinition,
  call: ToolCall,
  subjectLabel: string | null,
): string {
  const subject = subjectLabel ?? 'this item';

  switch (tool.name) {
    case 'record_dose': {
      const kind = text(call, 'eventKind') ?? '';
      const what = DOSE_WORDS[kind] ?? 'what happened';
      const note = text(call, 'note');
      const base = `Record ${what}, for ${subject}.`;
      // The note verbatim, in quotation marks, because it is the person's own words about their
      // own treatment and this app does not tidy those.
      return note === null ? base : `${base} With your note: "${note}".`;
    }

    case 'create_schedule': {
      const times = text(call, 'timesOfDay') ?? '';
      const zone = text(call, 'timeZone') ?? '';
      return `Set ${subject} to be taken at ${times}, in ${zone}. Kynviora will remind you on this phone.`;
    }

    case 'update_schedule': {
      const times = text(call, 'timesOfDay');
      const active = call.arguments['active'];
      if (active === false)
        return `Stop the reminders for ${subject}. Nothing recorded is removed.`;
      return times === null
        ? `Change the reminder times for ${subject}.`
        : `Change ${subject} to ${times}.`;
    }

    case 'add_medicine': {
      const name = text(call, 'displayName') ?? subject;
      const strength = text(call, 'strengthText');
      const form = text(call, 'dosageForm');
      const extras = [strength, form].filter((part): part is string => part !== null).join(', ');
      const written = extras === '' ? '' : ` (${extras})`;
      // "as you said it" is the whole promise of manual entry: nothing is looked up, corrected or
      // expanded, and `08` will not let a typed record become catalog truth.
      return `Write down a medicine called "${name}"${written}, exactly as you said it. Nothing is looked up.`;
    }

    case 'add_personal_care_item': {
      const name = text(call, 'displayName') ?? subject;
      return `Write down a personal-care product called "${name}", exactly as you said it.`;
    }

    case 'update_item': {
      const field = text(call, 'field') ?? 'a detail';
      const value = text(call, 'value') ?? '';
      return `Change ${field} on ${subject} to "${value}".`;
    }

    case 'start_package_capture': {
      const panel = text(call, 'panel') ?? '';
      const where = PANEL_WORDS[panel] ?? 'the pack';
      return `Open the camera, and guide you through photographing ${where}.`;
    }

    case 'confirm_extracted_item':
      return `Create ${subject} from the fields you confirmed. Nothing you did not confirm is written.`;

    case 'delete_item':
      return `Remove ${subject} from the shelf.`;

    case 'open_screen': {
      const screen = text(call, 'screen') ?? '';
      return `Open ${SCREEN_WORDS[screen] ?? 'that screen'}.`;
    }

    // Everything else. A tool reaching here either needs no confirmation - in which case the
    // sentence is a description rather than a consent - or is `TOUCH_ONLY`, where the screen it
    // opens already says what it will do, and a second spoken description of the same act is how
    // two descriptions of one act come to disagree. Listed rather than defaulted, so adding a
    // tool is a compile error here until somebody has decided which of the two it is.
    case 'list_medicines':
    case 'list_personal_care':
    case 'describe_item':
    case 'explain_what_is_missing':
    case 'list_schedules':
    case 'read_dose_history':
    case 'list_safety_state':
    case 'describe_alert':
    case 'list_people':
    case 'list_caregiver_access':
    case 'invite_caregiver':
    case 'revoke_caregiver_access':
    case 'prepare_visit_pack':
    case 'export_my_data':
    case 'record_consent':
    case 'delete_account':
    case 'open_item':
    case 'capture_next_package_photo':
    case 'read_extracted_fields':
    case 'list_pending_changes':
      return tool.description;
  }
}

/**
 * What to say about a refusal, as an utterance key rather than as a sentence.
 *
 * Returns a key into the Speech Gate's closed set, so a refusal cannot become free prose on its
 * way to being spoken. `13`'s rule about branching on codes, applied to what a person hears.
 */
export function utteranceForRefusal(
  refusal: ToolRefusal,
): 'touchOnly' | 'needsIdentity' | 'offline' | 'blocked' | 'notAllowed' | 'cannotDoThat' {
  switch (refusal) {
    case 'NOT_PERMITTED_BY_VOICE':
      return 'touchOnly';
    case 'STEP_UP_REQUIRED':
      return 'needsIdentity';
    case 'OFFLINE':
      return 'offline';
    case 'BLOCKED':
      return 'blocked';
    case 'CAPABILITY_MISSING':
      return 'notAllowed';
    case 'UNKNOWN_TOOL':
    case 'INVALID_ARGUMENTS':
    case 'UNEXPECTED_ARGUMENT':
    case 'CONFIRMATION_REQUIRED':
      // All four are the agent proposing something malformed, which is not the person's mistake
      // and must not be described to them as one. "I cannot do that by voice" is true of every
      // one of them and points at the screen, which can.
      return 'cannotDoThat';
  }
}
