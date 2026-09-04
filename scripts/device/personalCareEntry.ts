/**
 * What the personal-care entry scenario's evidence means.
 *
 * Spec references: `19` ("personal-care add/scan/OCR/confirm path"), `04` Phase 2.3 (manual
 * personal-care entry - "personal-care data is not reduced to name + barcode"), `10` (state the
 * limits where you state the findings), `02` (no completeness score), `09`, `BLK-007`, `DEV-040`.
 *
 * Kept apart from the runner so the judgements run in `npm run verify` with nothing attached
 * (DEC-102).
 *
 * WHAT THIS SCENARIO CAN AND CANNOT BE
 * `19` names four things in one line: add, scan, OCR and confirm. Two of them do not exist here
 * and are not going to before a decision somebody else has to make. There is no barcode scanner
 * (`04` Phase 2.2 has it unbuilt) and no OCR or multimodal provider is credentialed (`BLK-007`),
 * so a run that claimed the scenario whole would be claiming two capabilities this build does not
 * have. What is left is the half that exists and had never been driven on a phone: a person types
 * a personal-care product in by hand, and what they typed is what is stored.
 *
 * "CONFIRM", AS THIS BUILD MEANS IT
 * The confirm step in `19` is the one that follows a scan: a person is shown what a machine read
 * off a pack and says whether it is right. With no extraction there is nothing to be shown - and
 * the safety-relevant claim then inverts. What has to be true is that a record somebody typed is
 * **never** presented as confirmed, because confirming means something was read off the pack and
 * nothing was. `PC-5` measures that on the phone rather than in the API, because the sentence a
 * person reads is the whole of it.
 *
 * WHY THE LIMITS CHECK IS A SUBTRACTION
 * `PC-4` leaves the barcode, the batch code and the expiry date blank and fills the ingredient
 * declaration in. Three limits then have to be stated and the fourth must not be, which is the
 * only shape of check that can tell a screen computing its limits from what was typed apart from
 * one printing the same four sentences every time. A run that left everything blank would see all
 * four and could not distinguish them.
 *
 * WHAT IT LEAVES BEHIND
 * One personal-care item on the development household's shelf, permanently - items are archived
 * rather than deleted, and the app role is granted no delete. The name carries the run's own
 * suffix so runs can be told apart, which is also what makes `PC-0` answerable.
 */

import type { Check } from './analysis.js';

/**
 * The sentences the three blank fields have to cost, and the one the declaration has to answer.
 *
 * Written out rather than imported from `@kynviora/presentation`, on purpose. A check built from
 * the constants would agree with whatever the app currently says - including an edit that removed
 * the meaning - because both sides would have moved together. These are the sentences that have to
 * be on screen, and `personalCareEntry.test.ts` holds them against the package so a deliberate
 * rewording fails here rather than passing silently.
 */
export const LIMITS_OF_BLANK_FIELDS: readonly string[] = Object.freeze([
  'Without a barcode, Kynviora cannot match this to a product record, so a recall about the product will not reach this item.',
  'Without a batch or lot code, a recall can be matched to the product but never to your particular pack.',
  'Without an expiry date, Kynviora cannot tell you when this stops being in date.',
]);

/** The limit a filled-in declaration answers, which therefore must not be on screen. */
export const LIMIT_OF_NO_DECLARATION =
  'Without the ingredient list, Kynviora cannot check this against anything recorded on a profile.';

/** An item as `GET /v1/items` reports it. */
export interface ServerItem {
  readonly id: string;
  readonly profileId: string;
  readonly itemKind: string;
  readonly displayName: string;
  readonly identityVerification: string;
  readonly formulationVerification: string;
}

/** One row of the item detail's field lists, as the API renders it for a screen. */
export interface DetailField {
  readonly label: string;
  readonly value: string | null;
}

/** What this run typed, so every check can compare against the same values. */
export interface IntendedEntry {
  readonly displayName: string;
  /** The radio's label, which is what a person taps and what the dump reports. */
  readonly categoryLabel: string;
  /** The canonical value the label stands for, which is what has to reach the server. */
  readonly categoryValue: string;
  readonly ingredientDeclaration: string;
}

// ---------------------------------------------------------------------------
// PC-0 - the control
// ---------------------------------------------------------------------------

export interface ShelfPreconditionEvidence {
  /** Items the server had before anything was driven, or `null` if it could not be read. */
  readonly before: readonly ServerItem[] | null;
  readonly intended: IntendedEntry;
}

/**
 * Nothing on the shelf already carries the name this run is about to create.
 *
 * Without it, "an item with that name exists afterwards" is answered by a previous run rather
 * than by this one - and since items are archived rather than deleted, previous runs are always
 * still there.
 */
export function shelfPreconditionCheck(evidence: ShelfPreconditionEvidence): Check {
  const title = 'The shelf did not already hold the product this run adds';
  if (evidence.before === null) {
    return {
      id: 'PC-0',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The shelf could not be read, so there is nothing to compare against.',
    };
  }
  const clash = evidence.before.filter(
    (item) => item.displayName === evidence.intended.displayName,
  ).length;
  if (clash > 0) {
    return {
      id: 'PC-0',
      title,
      status: 'INCONCLUSIVE',
      detail:
        `${String(clash)} item(s) were already called ` +
        `${JSON.stringify(evidence.intended.displayName)}, so a later check for that name would ` +
        'be answered by a previous run.',
    };
  }
  return {
    id: 'PC-0',
    title,
    status: 'PASS',
    detail:
      `${String(evidence.before.length)} item(s) were on the shelf and none was called ` +
      `${JSON.stringify(evidence.intended.displayName)}, so anything by that name afterwards ` +
      'came from this run.',
  };
}

// ---------------------------------------------------------------------------
// PC-1 - the form took what a personal-care record needs
// ---------------------------------------------------------------------------

export interface PersonalCareFormEvidence {
  readonly steps: readonly (readonly [string, boolean])[];
  readonly intended: IntendedEntry;
  /** What the name field held once the run had finished typing. */
  readonly nameHeld: string | null;
  /** What the declaration field held. The long one, and the reason this form is not the other. */
  readonly declarationHeld: string | null;
  /**
   * Whether the category the run tapped reports itself as chosen.
   *
   * `null` where the option was not on screen at all, which is a different failure from a tap
   * that did not land.
   */
  readonly categoryChosen: boolean | null;
}

/**
 * The personal-care form was reachable and took all three of the fields that make it that form.
 *
 * Reported separately from what the server ended up with, because the two fail for entirely
 * different reasons and the fix for each is in a different place. Phase 2.3's second exit
 * criterion is that personal-care data is not reduced to name plus barcode, so a run that only
 * proved the name went in would have proved nothing about this form in particular.
 */
export function personalCareFormCheck(evidence: PersonalCareFormEvidence): Check {
  const title =
    'The personal-care form was reachable and took a name, a category and a declaration';
  const failed = evidence.steps.find(([, happened]) => !happened);
  if (failed !== undefined) {
    return {
      id: 'PC-1',
      title,
      status: 'INCONCLUSIVE',
      detail: `Could not ${failed[0]}, so no product was ever submitted.`,
    };
  }
  if (evidence.nameHeld !== evidence.intended.displayName) {
    return {
      id: 'PC-1',
      title,
      status: 'INCONCLUSIVE',
      detail:
        `The name field held ${evidence.nameHeld === null ? 'nothing readable' : JSON.stringify(evidence.nameHeld)} ` +
        `rather than ${JSON.stringify(evidence.intended.displayName)}. On this emulator that has ` +
        'meant a space ending the `input text` argument, or the stylus tutorial taking the ' +
        'keystrokes.',
    };
  }
  const declarationHeld = evidence.declarationHeld;
  if (declarationHeld === null || declarationHeld !== evidence.intended.ingredientDeclaration) {
    return {
      id: 'PC-1',
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The ingredients field held ' +
        `${declarationHeld === null ? 'nothing readable' : JSON.stringify(declarationHeld)} ` +
        `rather than ${JSON.stringify(evidence.intended.ingredientDeclaration)}.`,
    };
  }
  if (evidence.categoryChosen === null) {
    return {
      id: 'PC-1',
      title,
      status: 'INCONCLUSIVE',
      detail:
        `No option called ${JSON.stringify(evidence.intended.categoryLabel)} was on the form, so ` +
        'the category was never offered rather than never taken.',
    };
  }
  if (!evidence.categoryChosen) {
    return {
      id: 'PC-1',
      title,
      status: 'FAIL',
      detail:
        `${JSON.stringify(evidence.intended.categoryLabel)} was tapped and does not report itself ` +
        'as chosen, so the form did not record the category a person selected.',
    };
  }
  return {
    id: 'PC-1',
    title,
    status: 'PASS',
    detail:
      `The name held ${JSON.stringify(evidence.nameHeld)}, ` +
      `${JSON.stringify(evidence.intended.categoryLabel)} reported itself as chosen, and the ` +
      `declaration held ${String(declarationHeld.length)} characters.`,
  };
}

// ---------------------------------------------------------------------------
// PC-2 - the server has the product, once, as personal care
// ---------------------------------------------------------------------------

export interface PersonalCareCreatedEvidence {
  readonly before: readonly ServerItem[] | null;
  readonly after: readonly ServerItem[] | null;
  readonly intended: IntendedEntry;
  /** The profile the run added to, so an item on another profile's shelf is not counted. */
  readonly profileId: string;
  /**
   * Whether the form was actually filled in and saved.
   *
   * Without this the check reads an empty shelf as a save that produced nothing, and reports
   * **FAIL - the form accepted every value and the save produced nothing** about a run in which
   * the app never started. That happened, on a launch Metro dropped, and it is exactly the failure
   * DEC-102 exists to prevent: a harness that could not look must not describe what it saw.
   */
  readonly submitted: boolean;
}

/**
 * Exactly one item by that name, on the right shelf, and it is a personal-care product.
 *
 * "Exactly one" rather than "at least one" because the create carries an idempotency key
 * generated once when the form opens, and a second row would mean it did not do its job. The kind
 * is checked as well: the shelf offers two add buttons and they differ only in which one was
 * pressed, so a wiring mistake there produces a medicine record with an ingredient list on it and
 * nothing else complains.
 */
export function personalCareCreatedCheck(evidence: PersonalCareCreatedEvidence): Check {
  const title = 'The product exists on the server, once, as a personal-care item';
  if (!evidence.submitted) {
    return {
      id: 'PC-2',
      title,
      status: 'INCONCLUSIVE',
      detail: 'No save was ever driven, so the shelf says nothing about what a save would do.',
    };
  }
  if (evidence.after === null || evidence.before === null) {
    return {
      id: 'PC-2',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The shelf could not be read after the save.',
    };
  }

  const matching = evidence.after.filter(
    (item) =>
      item.displayName === evidence.intended.displayName && item.profileId === evidence.profileId,
  );

  if (matching.length === 0) {
    return {
      id: 'PC-2',
      title,
      status: 'FAIL',
      detail:
        `No item called ${JSON.stringify(evidence.intended.displayName)} reached the server. The ` +
        'form accepted every value and the save produced nothing.',
    };
  }
  if (matching.length > 1) {
    return {
      id: 'PC-2',
      title,
      status: 'FAIL',
      detail:
        `${String(matching.length)} items by that name exist. One save has become two products ` +
        'on a shelf, which is what the idempotency key on the create is for.',
    };
  }
  const only = matching[0];
  if (only === undefined || only.itemKind !== 'PERSONAL_CARE') {
    return {
      id: 'PC-2',
      title,
      status: 'FAIL',
      detail:
        `The item was stored as ${JSON.stringify(only?.itemKind ?? 'nothing')} rather than ` +
        'PERSONAL_CARE, so the shelf sent the wrong kind for the button that was pressed.',
    };
  }
  if (evidence.after.length !== evidence.before.length + 1) {
    return {
      id: 'PC-2',
      title,
      status: 'FAIL',
      detail:
        `The shelf went from ${String(evidence.before.length)} items to ` +
        `${String(evidence.after.length)}, so something other than this one product changed.`,
    };
  }
  return {
    id: 'PC-2',
    title,
    status: 'PASS',
    detail:
      `One PERSONAL_CARE item called ${JSON.stringify(evidence.intended.displayName)} exists on ` +
      'this profile, and the shelf grew by exactly one.',
  };
}

// ---------------------------------------------------------------------------
// PC-3 - what was typed is what is stored
// ---------------------------------------------------------------------------

export interface StoredFieldsEvidence {
  /** The detail's category fields, or `null` where the record could not be read. */
  readonly categoryFields: readonly DetailField[] | null;
  readonly intended: IntendedEntry;
}

/**
 * The category and the declaration came back exactly as they went in.
 *
 * `AddItem` promises this in as many words: nothing typed there is repaired, because a market this
 * app had silently upper-cased is one the person can no longer check against the pack in their
 * hand. An ingredient declaration is the sharpest case - `09` reads it in printed order, and a
 * list this app tidied would be a different list.
 */
export function storedFieldsCheck(evidence: StoredFieldsEvidence): Check {
  const title = 'The category and the ingredient list are stored exactly as typed';
  if (evidence.categoryFields === null) {
    return {
      id: 'PC-3',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The item detail could not be read, so there is nothing to compare.',
    };
  }

  const valueOf = (label: string): string | null =>
    evidence.categoryFields?.find((field) => field.label === label)?.value ?? null;

  const declaration = valueOf('Ingredients as printed');
  const category = valueOf('Kind of product');

  if (declaration === null || declaration !== evidence.intended.ingredientDeclaration) {
    return {
      id: 'PC-3',
      title,
      status: 'FAIL',
      detail:
        'The stored declaration is ' +
        `${declaration === null ? 'absent' : JSON.stringify(declaration)}, and ` +
        `${JSON.stringify(evidence.intended.ingredientDeclaration)} was typed.`,
    };
  }
  // The detail renders the category as a phrase rather than as its stored key, which is what a
  // person reads - so the label is what this compares, and a stored key the presentation layer
  // cannot name would come back absent rather than as itself.
  if (category !== evidence.intended.categoryLabel) {
    return {
      id: 'PC-3',
      title,
      status: 'FAIL',
      detail:
        `The stored category reads ${category === null ? 'as not recorded' : JSON.stringify(category)}, ` +
        `and ${JSON.stringify(evidence.intended.categoryLabel)} was chosen.`,
    };
  }
  return {
    id: 'PC-3',
    title,
    status: 'PASS',
    detail:
      `The record holds ${JSON.stringify(category)} and the declaration character for ` +
      `character (${String(declaration.length)} characters, unchanged).`,
  };
}

// ---------------------------------------------------------------------------
// PC-4 - the app said what the record cannot do, and only that
// ---------------------------------------------------------------------------

export interface LimitsEvidence {
  /** Every accessible name on the screen the save produced, or `null` if it could not be read. */
  readonly screenText: readonly string[] | null;
  /** The limits that must be stated, because those fields were left blank. */
  readonly expected: readonly string[];
  /** The limit that must not be stated, because that field was filled in. */
  readonly refused: string;
}

/**
 * The record's limits are the ones its blank fields cost, and not a fixed list.
 *
 * The subtraction is the check. Three fields were left blank and one was filled in, so three
 * sentences have to be on screen and the fourth must not be - and a screen printing all four
 * every time passes every other reading of "the limits are stated". `10` is about a system stating
 * its limits where it states its findings, which is worth nothing if the statement is the same
 * whatever the person typed.
 */
export function limitsStatedCheck(evidence: LimitsEvidence): Check {
  const title = 'The screen stated what this record cannot do, computed from what was left blank';
  if (evidence.screenText === null) {
    return {
      id: 'PC-4',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The screen the save produced could not be read.',
    };
  }

  const onScreen = (sentence: string): boolean =>
    evidence.screenText?.some((text) => text.includes(sentence)) ?? false;

  const missing = evidence.expected.filter((sentence) => !onScreen(sentence));
  if (missing.length > 0) {
    return {
      id: 'PC-4',
      title,
      status: 'FAIL',
      detail:
        `${String(missing.length)} of ${String(evidence.expected.length)} limits the blank fields ` +
        `cost were not on screen. The first missing one begins ${JSON.stringify(missing[0]?.slice(0, 60) ?? '')}.`,
    };
  }
  if (onScreen(evidence.refused)) {
    return {
      id: 'PC-4',
      title,
      status: 'FAIL',
      detail:
        'The screen said the ingredient list is missing, and it was typed in. The limits are a ' +
        'fixed list rather than a reading of the record.',
    };
  }
  return {
    id: 'PC-4',
    title,
    status: 'PASS',
    detail:
      `All ${String(evidence.expected.length)} limits the blank fields cost are stated, and the ` +
      'one the declaration answers is absent.',
  };
}

// ---------------------------------------------------------------------------
// PC-5 - nothing typed is presented as confirmed
// ---------------------------------------------------------------------------

export interface ConfirmationEvidence {
  /** Every accessible name on the item's own screen, or `null` where it could not be read. */
  readonly screenText: readonly string[] | null;
  /** What the server holds, so a screen agreeing with a wrong record is not read as agreement. */
  readonly stored: ServerItem | null;
}

/**
 * A record somebody typed is shown as not confirmed, on the phone, in words.
 *
 * This is what is left of `19`'s "confirm" step in a build with no extraction (`BLK-007`). There
 * is nothing for a person to confirm, so the claim that matters is the opposite one: confirming
 * means something was read off the pack, and a manual record that displayed as verified would be
 * this app asserting a check it never made about somebody's product.
 *
 * Both halves are required. A screen saying "not verified" over a record the server marked
 * verified is a screen that is about to stop saying it.
 */
export function notConfirmedCheck(evidence: ConfirmationEvidence): Check {
  const title = 'A product somebody typed in is not presented as confirmed';
  if (evidence.screenText === null || evidence.stored === null) {
    return {
      id: 'PC-5',
      title,
      status: 'INCONCLUSIVE',
      detail:
        evidence.stored === null
          ? 'The stored record could not be read.'
          : "The item's own screen could not be read.",
    };
  }

  if (
    evidence.stored.identityVerification !== 'UNVERIFIED' ||
    evidence.stored.formulationVerification !== 'UNVERIFIED'
  ) {
    return {
      id: 'PC-5',
      title,
      status: 'FAIL',
      detail:
        `The server stored identity as ${evidence.stored.identityVerification} and formulation as ` +
        `${evidence.stored.formulationVerification}. Nothing was read off a pack, so neither can ` +
        'be anything but UNVERIFIED.',
    };
  }

  const says = (fragment: string): boolean =>
    evidence.screenText?.some((text) => text.includes(fragment)) ?? false;

  const stated = ['Product not verified', 'Formula not verified'].filter((phrase) => says(phrase));
  if (stated.length < 2) {
    return {
      id: 'PC-5',
      title,
      status: 'FAIL',
      detail:
        'The record is unverified on the server and the screen does not say so. It states ' +
        `${String(stated.length)} of the two, so a person reading it cannot tell a product ` +
        'Kynviora checked from one they typed.',
    };
  }

  return {
    id: 'PC-5',
    title,
    status: 'PASS',
    detail:
      "Identity and formulation are both UNVERIFIED on the server, and the item's own screen " +
      'says "Product not verified" and "Formula not verified".',
  };
}
