/**
 * The form for completing a review task.
 *
 * Spec references: `04` Phase 8.3 (completing a task updates the relevant authoritative record),
 * `18` (familiar words first, one idea per sentence, no shaming, ask for what you need and say
 * why), `09` (Kynviora never records that it told someone to stop a prescription medicine),
 * DEC-027, trap 16.
 *
 * WHY THERE IS NO "DONE" BUTTON
 * A review task closes by writing to the record it is about, and the domain refuses a completion
 * with an empty change set. So the form's job is to ask for the value, not to collect a
 * confirmation - every field here corresponds to one entry in `COMPLETABLE_FIELDS`, and a test
 * asserts the two agree in both directions. A field this form offered that the domain would refuse
 * is a control that always errors; a field the domain permits that this form omits is a task
 * nobody can complete.
 *
 * WHY "NOT APPLICABLE" IS NOT OFFERED HERE
 * The API accepts it and the domain requires it to write something too - deciding a task does not
 * apply is itself information about the record. What it should write differs per kind and, for
 * most kinds, no existing field expresses it: there is no `batch_verification` member meaning
 * "checked, this pack has no batch number". Inventing one would be inventing a medical record
 * semantic, which is a product decision rather than an implementation detail. The one kind where
 * the vocabulary already has the word - a safety receipt resolved as `NOT_APPLICABLE` - offers it
 * as a **value**, which is where it belongs (`DEV-023`).
 */

import { COMPLETABLE_FIELDS, REVIEW_TASK_KINDS, type ReviewTaskKind } from '@kynviora/domain';

/**
 * How a field is entered.
 *
 * A closed set, so a field cannot be added without deciding what the user does with it. `TIMESTAMP
 * _NOW` has no input at all: confirming a record is current is a button, and asking someone to
 * type today's date would be asking for something the device already knows.
 */
export const FIELD_INPUTS = [
  'TEXT',
  'NUMBER',
  'CHOICE',
  'TIMESTAMP_NOW',
  'DATE',
  /**
   * Names another record, and needs a picker rather than a keyboard.
   *
   * `batch_id` and `formulation_id` are foreign keys into the catalog, not strings someone reads
   * off a pack. Offering either as a text box produced a control that always failed - the server
   * casts the value to `uuid` and a typed lot code is not one. Found by running it.
   */
  'REFERENCE',
] as const;
export type FieldInput = (typeof FIELD_INPUTS)[number];

export interface FieldChoice {
  readonly value: string;
  readonly label: string;
}

export interface EditableField {
  readonly field: string;
  /** Short visible label. Always rendered next to the control, never a placeholder alone. */
  readonly label: string;
  /**
   * Why Kynviora is asking.
   *
   * `18` requires the reason for a request to be stated rather than assumed. Someone being asked
   * for a batch number deserves to know it is what makes a recall check possible for them.
   */
  readonly help: string;
  readonly input: FieldInput;
  /** Present for `CHOICE` and empty otherwise. */
  readonly choices: readonly FieldChoice[];
  /**
   * The field the form leads with, and names when nothing has been entered at all.
   *
   * Exactly one per kind. It is deliberately **not** "this field must be filled in": the domain's
   * rule is that a completion writes *something*, and several kinds offer alternatives rather
   * than a set - correcting any one of the four label fields completes an unresolved-extraction
   * task. So the primary field is what the message points at when the form is empty, not a
   * separate constraint the user has to satisfy. Modelling it as "required" made the button
   * refuse completions the server would have accepted.
   */
  readonly primary: boolean;
}

/**
 * Every field any task kind can write, with the words the user reads.
 *
 * Keyed by the column name the API expects, so this table and `COMPLETABLE_FIELDS` are checked
 * against each other rather than kept in step by hand.
 */
const FIELD_DEFINITIONS: Readonly<Record<string, Omit<EditableField, 'field'>>> = Object.freeze({
  last_reviewed_at: {
    label: 'Confirm these details are right',
    help: 'Kynviora records when you last checked this, so it can tell you how current it is.',
    input: 'TIMESTAMP_NOW',
    choices: [],
    primary: true,
  },
  batch_id: {
    label: 'Batch or lot number',
    help: 'Printed on the pack, often near the expiry date. It is what lets Kynviora tell you whether a recall covers your pack rather than only the product.',
    // A reference to a `batch_or_lot` record, not the printed code itself. Recording one means
    // finding or creating that record, which is guided capture's job (`DEV-024`).
    input: 'REFERENCE',
    choices: [],
    primary: true,
  },
  batch_verification: {
    label: 'Where the batch number came from',
    help: 'Kynviora keeps how it knows something separate from what it knows.',
    input: 'CHOICE',
    choices: [
      { value: 'CONFIRMED', label: 'I read it off the pack' },
      { value: 'PROBABLE', label: 'I am fairly sure, but not certain' },
      { value: 'UNVERIFIED', label: 'I am not sure' },
    ],
    primary: false,
  },
  formulation_id: {
    label: 'Ingredient list',
    help: 'Which formula this pack matches. Kynviora asks because manufacturers change ingredients without changing the name.',
    // A reference to a `marketed_formulation` record. Same reason as `batch_id`.
    input: 'REFERENCE',
    choices: [],
    primary: true,
  },
  formulation_verification: {
    label: 'How the ingredients were confirmed',
    help: 'Reading the list off the pack you have is the only thing that confirms your pack.',
    input: 'CHOICE',
    choices: [
      { value: 'CONFIRMED', label: 'I read the list on this pack' },
      { value: 'PARTIAL', label: 'I read part of it' },
      { value: 'UNVERIFIED', label: 'I have not checked' },
    ],
    primary: false,
  },
  display_name: {
    label: 'Product name',
    help: 'As it appears on the pack.',
    input: 'TEXT',
    choices: [],
    primary: true,
  },
  strength_text: {
    label: 'Strength',
    help: 'For example 500 mg. Copy it exactly as written on the pack.',
    input: 'TEXT',
    choices: [],
    primary: false,
  },
  dosage_form: {
    label: 'Form',
    help: 'Tablet, capsule, cream, drops.',
    input: 'TEXT',
    choices: [],
    primary: false,
  },
  directions_text: {
    label: 'Directions',
    help: 'What the label or your prescriber says about taking it. Kynviora records this and does not interpret it.',
    input: 'TEXT',
    choices: [],
    primary: false,
  },
  expires_at: {
    label: 'New end date for this access',
    help: 'Access ends on this date unless it is renewed again.',
    input: 'DATE',
    choices: [],
    primary: false,
  },
  status: {
    label: 'What should happen to this access',
    help: 'Ending access takes effect immediately.',
    input: 'CHOICE',
    choices: [
      { value: 'ACTIVE', label: 'Keep it, with the new end date' },
      { value: 'REVOKED', label: 'End it now' },
    ],
    primary: true,
  },
  resolution: {
    label: 'What you did',
    help: 'Kynviora records what you decided. It does not decide for you.',
    input: 'CHOICE',
    // Exactly the `receipt_resolution_valid` vocabulary. There is no STOPPED_MEDICINE member,
    // because `09` forbids Kynviora from recording that it told someone to stop a prescription
    // medicine - it is never permitted to say so, so there is no word for it here.
    choices: [
      { value: 'REVIEWED', label: 'I read it' },
      { value: 'NOT_APPLICABLE', label: 'This does not apply to my product' },
      { value: 'RETURNED_OR_DISPOSED', label: 'I returned or disposed of it' },
      { value: 'QUARANTINED', label: 'I set it aside for now' },
      { value: 'DISCUSSED_WITH_PROFESSIONAL', label: 'I discussed it with a health professional' },
      { value: 'ITEM_IDENTITY_CORRECTED', label: 'I corrected the product details' },
      { value: 'REPORTED_INCORRECT_MATCH', label: 'This is not my product' },
    ],
    primary: true,
  },
  quantity_remaining: {
    label: 'How many are left',
    help: 'Counting what is actually in the pack is the only thing that makes a refill estimate mean anything.',
    input: 'NUMBER',
    choices: [],
    primary: true,
  },
  doses_per_day: {
    label: 'How many you take each day',
    help: 'Kynviora uses this only to estimate when you might run low.',
    input: 'NUMBER',
    choices: [],
    primary: false,
  },
});

export interface TaskForm {
  readonly kind: ReviewTaskKind;
  readonly fields: readonly EditableField[];
  /**
   * Whether this form can complete the task on its own.
   *
   * False when the field the task is actually about names another record: a batch or a
   * formulation is found or created by guided capture, not typed. When it is false the form
   * offers **no** fields at all, deliberately - `BATCH_MISSING` also permits writing
   * `batch_verification`, and letting someone record "I am not sure" and close a task called
   * "add the batch number" would be a mark-done path wearing a different label (trap 16).
   */
  readonly completableHere: boolean;
  /** Why not, when it is not. Shown instead of the form. */
  readonly needsCapture: string | null;
  /**
   * The one sentence explaining why completing this writes to the record.
   *
   * Present on every form, because someone expecting a tick box needs to know why the screen is
   * asking for something instead (`04` Phase 8.3 exit criterion 2).
   */
  readonly completionNote: string;
}

export const COMPLETION_NOTE =
  'Marking this done updates the record itself, so what Kynviora tells you afterwards is based on it.';

/**
 * Shown where the task needs a record this screen cannot create.
 *
 * Says what is missing and does not apologise or blame. `18` requires Kynviora to be plain about
 * what it cannot do rather than offering a control that fails.
 */
export const NEEDS_CAPTURE =
  'This one needs the pack in front of you. Kynviora will ask you to scan or photograph it, and ' +
  'that part of the app is not ready yet.';

/**
 * The form for a task kind.
 *
 * Field order follows `COMPLETABLE_FIELDS`, which puts the value before the statement about how it
 * was obtained - the order someone actually works in when holding a pack.
 */
export function taskForm(kind: ReviewTaskKind): TaskForm {
  const fields = COMPLETABLE_FIELDS[kind].map((field) => {
    const definition = FIELD_DEFINITIONS[field];
    if (definition === undefined) {
      // Unreachable while the exhaustiveness test passes, and a loud failure rather than a
      // blank control if it ever does not.
      throw new Error(
        `No editor definition for the field "${field}". Every entry in COMPLETABLE_FIELDS ` +
          'needs a label and a reason, because a control with neither asks the user for ' +
          'something without saying what or why.',
      );
    }
    return { field, ...definition };
  });

  // The primary field is what the task is about. If that names another record, nothing this form
  // could collect completes the task honestly.
  const completableHere = fields.every((field) => !field.primary || field.input !== 'REFERENCE');

  return {
    kind,
    fields: completableHere ? fields : [],
    completableHere,
    needsCapture: completableHere ? null : NEEDS_CAPTURE,
    completionNote: COMPLETION_NOTE,
  };
}

/** Every user-visible string in this module, for the copy scans. */
export const ALL_TASK_EDITOR_STRINGS: readonly string[] = Object.freeze([
  COMPLETION_NOTE,
  NEEDS_CAPTURE,
  ...Object.values(FIELD_DEFINITIONS).flatMap((definition) => [
    definition.label,
    definition.help,
    ...definition.choices.map((choice) => choice.label),
  ]),
]);

/** Every field the domain permits has a definition here, and nothing here is unreachable. */
export function everyCompletableFieldEditable(): boolean {
  const permitted = new Set(REVIEW_TASK_KINDS.flatMap((kind) => COMPLETABLE_FIELDS[kind]));
  const defined = new Set(Object.keys(FIELD_DEFINITIONS));
  if (permitted.size !== defined.size) return false;
  for (const field of permitted) if (!defined.has(field)) return false;
  return true;
}
