/**
 * What the safety-screen scenario's evidence means.
 *
 * Spec references: `19` ("safety alert open/resolution"), `04` Phase 7.1 (the assessment inbox),
 * `09` (a coverage statement accompanies every result), `18` (never present an absence of findings
 * as reassurance), `23` D-005 (evidence level and urgency are never combined) and D-014 (an
 * absence of a matched rule must never render as approval), `02` (no aggregate score, no badge),
 * DEC-016, DEC-045, `BLK-006`, `DEV-040`.
 *
 * Kept apart from the runner so the judgements run in `npm run verify` with nothing attached
 * (DEC-102).
 *
 * WHAT THIS SCENARIO CAN BE, AND WHY THE OTHER HALF IS NOT A GAP THAT CODE CLOSES
 * `19` asks for "safety alert open/resolution". Opening an alert and recording what somebody did
 * about it needs a published alert, and nothing in this build can publish one: `BLK-006` has no
 * qualified clinical or regulatory reviewer, and DEC-016 has every shipped regulatory fixture
 * deliberately refused by the Citation Gate. Driving that half would mean manufacturing an
 * approval, which is the one thing the governance chapter exists to prevent - so it stays undriven
 * and stays named.
 *
 * The half that can be driven is the one that is true of every profile in this build and will stay
 * true of most items in any build: **Kynviora has nothing to say, and has to say so.** That is not
 * a lesser scenario. `23` D-014 is a safety requirement in its own right, and the failure it
 * describes - an absence of findings read as a finding of absence - is the failure a person is
 * actually exposed to today, on this screen, on a phone.
 *
 * WHY THE OMISSION CHECK IS FIRST
 * The quietest way to render an absence as approval is to leave the row out. A screen listing
 * only items with alerts looks calm and correct, and a person reading it cannot tell "checked,
 * nothing matched" from "never checked" from "not on this list at all". `SAF-1` is therefore about
 * the count of lines before it is about anything any line says.
 */

import type { Check } from './analysis.js';

/** One line of the safety inbox, as the API reports it. */
export interface InboxLine {
  readonly ownedItemId: string;
  readonly displayName: string;
  readonly alertPublicationId: string | null;
  readonly state: string;
  readonly urgency: string | null;
  readonly evidenceLevel: string | null;
  readonly lastAssessedAt: string | null;
}

export interface InboxResponse {
  readonly lines: readonly InboxLine[];
  readonly totalItems: number;
}

/**
 * The sentence `09` requires beside every result.
 *
 * Duplicated here rather than imported from `@kynviora/contracts`, on purpose. A check that
 * imported the constant would pass on any wording the app happened to be shipping, including an
 * edit that turned it into reassurance - it would only be measuring that the screen and the
 * package agree. This is the sentence that has to be on screen.
 */
export const COVERAGE_SENTENCE =
  'Kynviora has no reviewed safety information to show for this profile. That is not the same ' +
  'as saying there is nothing to find.';

/**
 * The chip label for a line with nothing to report.
 *
 * Not what `SAF-2` looks for. This screen draws a filter carrying exactly this string, so a check
 * for it would pass on a screen whose lines showed no state at all - the filter alone would answer
 * it. It is here because it is what a filter is tapped by, and because a report should print the
 * short form.
 */
export const INSUFFICIENT_LABEL = 'Not enough information';

/**
 * What a line with nothing to report actually announces.
 *
 * The whole sentence, which only a line's chip carries: `18` requires the state to be announced
 * with the qualification attached rather than as a bare label, and that is exactly what
 * distinguishes a line from the filter of the same name.
 */
export const INSUFFICIENT_ANNOUNCEMENT =
  'Not enough information. Kynviora cannot check this item yet. Adding label or batch details ' +
  'would help.';

/** What a line whose item has never been assessed has to say, rather than leaving it blank. */
export const NEVER_ASSESSED_SENTENCE = 'Kynviora has not assessed this item.';

/** The control that explains a live alert. There is no alert here, so there must be no control. */
export const EXPLAIN_CONTROL = 'Why am I seeing this?';

// ---------------------------------------------------------------------------
// SAF-0 - the control
// ---------------------------------------------------------------------------

export interface InboxPreconditionEvidence {
  readonly inbox: InboxResponse | null;
}

/**
 * The shelf has items, and the server publishes no alert about any of them.
 *
 * Both halves are the control. A screen with no lines is the right screen for a profile with no
 * items, so "every item has a line" is answerable only once there are items; and every check below
 * is about how this app renders having nothing to say, which is only what is being measured while
 * the server genuinely has nothing to say.
 */
export function inboxPreconditionCheck(evidence: InboxPreconditionEvidence): Check {
  const title = 'The shelf has items and the server publishes no alert about any of them';
  if (evidence.inbox === null) {
    return {
      id: 'SAF-0',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The safety inbox could not be read, so the screen cannot be judged against it.',
    };
  }
  if (evidence.inbox.totalItems === 0) {
    return {
      id: 'SAF-0',
      title,
      status: 'INCONCLUSIVE',
      detail:
        'This profile has nothing on its shelf, so a safety screen with no lines is correct and ' +
        'the checks below would pass without measuring anything.',
    };
  }
  const published = evidence.inbox.lines.filter((line) => line.alertPublicationId !== null);
  if (published.length > 0) {
    return {
      id: 'SAF-0',
      title,
      status: 'INCONCLUSIVE',
      detail:
        `${String(published.length)} line(s) carry a published alert. This scenario is about how ` +
        'the app renders having nothing to say, and something has been published - which ' +
        `${published.length === 1 ? 'is' : 'are'} worth understanding before this is re-run, ` +
        'because `BLK-006` says nothing in this build can be approved.',
    };
  }
  return {
    id: 'SAF-0',
    title,
    status: 'PASS',
    detail:
      `${String(evidence.inbox.totalItems)} item(s) are on this shelf and no alert is published ` +
      'for any of them, so what follows is measured against a screen that genuinely has nothing ' +
      'to report.',
  };
}

// ---------------------------------------------------------------------------
// SAF-1 - every item has a line
// ---------------------------------------------------------------------------

export interface ScreenEvidence {
  /** Every accessible name the app is drawing, or `null` where the screen could not be read. */
  readonly screenText: readonly string[] | null;
  readonly inbox: InboxResponse | null;
}

function unreadable(id: string, title: string, evidence: ScreenEvidence): Check | null {
  if (evidence.inbox === null) {
    return { id, title, status: 'INCONCLUSIVE', detail: 'The safety inbox could not be read.' };
  }
  if (evidence.screenText === null) {
    return { id, title, status: 'INCONCLUSIVE', detail: 'The screen could not be read.' };
  }
  return null;
}

/** Whether any name on the screen contains this fragment. */
function says(screenText: readonly string[], fragment: string): boolean {
  return screenText.some((text) => text.includes(fragment));
}

/**
 * Every item the server knows about is named on the screen.
 *
 * `23` D-014 forbids an absence of a matched rule rendering as approval, and leaving the row out
 * is the quietest way to do it - the screen looks calm, and nobody can tell "checked, nothing
 * matched" from "never on this list". This screen used to list published alerts, which meant an
 * item with no alert did not appear at all.
 */
export function everyItemHasALineCheck(evidence: ScreenEvidence): Check {
  const title = 'Every item on the shelf has a line on the safety screen';
  const blocked = unreadable('SAF-1', title, evidence);
  if (blocked !== null) return blocked;
  const inbox = evidence.inbox as InboxResponse;
  const screenText = evidence.screenText as readonly string[];

  if (inbox.lines.length !== inbox.totalItems) {
    return {
      id: 'SAF-1',
      title,
      status: 'FAIL',
      detail:
        `The server returned ${String(inbox.lines.length)} lines for ${String(inbox.totalItems)} ` +
        'items with no filter applied, so the omission is upstream of the screen.',
    };
  }

  const missing = inbox.lines.filter((line) => !says(screenText, line.displayName));
  if (missing.length > 0) {
    return {
      id: 'SAF-1',
      title,
      status: 'FAIL',
      detail:
        `${String(missing.length)} of ${String(inbox.lines.length)} items are not on the screen. ` +
        `The first is ${JSON.stringify(missing[0]?.displayName ?? '')}. An item with nothing to ` +
        'report reads as an item that was checked and cleared.',
    };
  }
  return {
    id: 'SAF-1',
    title,
    status: 'PASS',
    detail: `All ${String(inbox.lines.length)} items on this shelf are named on the screen.`,
  };
}

// ---------------------------------------------------------------------------
// SAF-2 - each line states the limitation rather than leaving it blank
// ---------------------------------------------------------------------------

/**
 * The state is on screen, and it is the one that names a limit rather than making a claim.
 *
 * Two things at once, because either alone passes a screen nobody should ship. A screen showing no
 * state at all is an item a person would read as fine; a screen showing a state the server did not
 * send is worse. `23` open questions asks what "no current matched alert" should be called so
 * users do not misread it as "safe", and the answer this build uses names what was checked - so
 * the label being on screen is the answer being delivered.
 */
export function stateIsStatedCheck(evidence: ScreenEvidence): Check {
  const title = 'Each line says what Kynviora can say, and it is the limitation';
  const blocked = unreadable('SAF-2', title, evidence);
  if (blocked !== null) return blocked;
  const inbox = evidence.inbox as InboxResponse;
  const screenText = evidence.screenText as readonly string[];

  const unexpected = inbox.lines.filter((line) => line.state !== 'INSUFFICIENT_DATA');
  if (unexpected.length > 0) {
    return {
      id: 'SAF-2',
      title,
      status: 'INCONCLUSIVE',
      detail:
        `${String(unexpected.length)} line(s) are in a state other than INSUFFICIENT_DATA ` +
        `(the first is ${JSON.stringify(unexpected[0]?.state ?? '')}), so the label this check ` +
        'looks for is not the label that should be on screen.',
    };
  }

  if (!says(screenText, INSUFFICIENT_ANNOUNCEMENT)) {
    // The whole announcement, not the label. This screen draws a filter called "Not enough
    // information", so a check for the short form is answered by the filter and passes over lines
    // showing no state at all - which was this rule's first draft.
    return {
      id: 'SAF-2',
      title,
      status: 'FAIL',
      detail:
        `Every line is INSUFFICIENT_DATA and no line announces ${JSON.stringify(INSUFFICIENT_LABEL)} ` +
        'with its qualification attached, so nothing tells a person that these items have not ' +
        'been checked.',
    };
  }
  if (!says(screenText, NEVER_ASSESSED_SENTENCE)) {
    return {
      id: 'SAF-2',
      title,
      status: 'FAIL',
      detail:
        `No line says ${JSON.stringify(NEVER_ASSESSED_SENTENCE)}. An item Kynviora has never ` +
        'assessed must not read like one it checked this morning, and a blank where the date ' +
        'goes reads exactly like that.',
    };
  }
  return {
    id: 'SAF-2',
    title,
    status: 'PASS',
    detail:
      `All ${String(inbox.lines.length)} lines are INSUFFICIENT_DATA, a line announces ` +
      `${JSON.stringify(INSUFFICIENT_LABEL)} with its qualification attached, and the screen says ` +
      'the items have not been assessed.',
  };
}

// ---------------------------------------------------------------------------
// SAF-3 - the coverage statement is on screen
// ---------------------------------------------------------------------------

/**
 * The sentence that stops an empty screen reading as an all-clear.
 *
 * `09` requires the coverage statement to accompany the result rather than being inferred from its
 * absence, and this is the screen where inferring it is easiest: every line says nothing matched,
 * and the obvious conclusion is that the shelf has been cleared. Compared against the sentence
 * written here rather than against the app's own constant - see the note on {@link
 * COVERAGE_SENTENCE}.
 */
export function coverageStatedCheck(evidence: ScreenEvidence): Check {
  const title = 'The coverage statement is on screen, in the state where it matters most';
  const blocked = unreadable('SAF-3', title, evidence);
  if (blocked !== null) return blocked;
  const screenText = evidence.screenText as readonly string[];

  if (!says(screenText, COVERAGE_SENTENCE)) {
    const partial = says(screenText, 'no reviewed safety information');
    return {
      id: 'SAF-3',
      title,
      status: 'FAIL',
      detail: partial
        ? 'The screen says Kynviora has no reviewed safety information and drops the sentence ' +
          'that follows it. The second half is the whole point: without it the first half reads ' +
          'as there being nothing to find.'
        : 'The coverage statement is nowhere on the screen, so an empty result is left to speak ' +
          'for itself.',
    };
  }
  return {
    id: 'SAF-3',
    title,
    status: 'PASS',
    detail: 'Both halves of the coverage statement are on screen, under the lines they qualify.',
  };
}

// ---------------------------------------------------------------------------
// SAF-4 - no control offers an explanation that does not exist
// ---------------------------------------------------------------------------

/**
 * There is no "Why am I seeing this?" on a screen with nothing to explain.
 *
 * DEC-045: absent rather than disabled. A greyed-out control states that an explanation exists and
 * is being withheld, which on a safety screen is a worse sentence than silence - and a control
 * that opened an empty detail would be worse still.
 */
export function noOrphanExplanationCheck(evidence: ScreenEvidence): Check {
  const title = 'No line offers to explain an alert that does not exist';
  const blocked = unreadable('SAF-4', title, evidence);
  if (blocked !== null) return blocked;
  const screenText = evidence.screenText as readonly string[];

  if (says(screenText, EXPLAIN_CONTROL)) {
    return {
      id: 'SAF-4',
      title,
      status: 'FAIL',
      detail:
        `${JSON.stringify(EXPLAIN_CONTROL)} is on a screen where no line carries a publication. ` +
        'It either opens nothing or states that an explanation is being withheld.',
    };
  }
  return {
    id: 'SAF-4',
    title,
    status: 'PASS',
    detail:
      'No explanation control is drawn, which is what DEC-045 asks for: absent, not disabled, ' +
      'where there is nothing behind it.',
  };
}

// ---------------------------------------------------------------------------
// SAF-5 - nothing counts or ranks
// ---------------------------------------------------------------------------

/** A bare number, which is the shape a badge has. */
const BADGE = /^\(?\d{1,3}\)?$/;

/** "3 items need attention", and everything shaped like it. */
const COUNT_OF_TROUBLE =
  /\b\d+\s+(?:\w+\s+){0,2}(?:need|needs|require|requires|outstanding|urgent|await|awaiting)\b/i;

/**
 * Anything the subset line is allowed to say, so a legitimate number is not read as a badge.
 *
 * The screen may state the size of the shelf, which is a fact about the shelf. It may not state
 * how much of it is a problem, which is a judgement `02` refuses and which no code path in this
 * app could compute - safety is server-authoritative (DEC-010) and the client renders what a
 * reviewer approved.
 */
const SUBSET_LINE = /^Showing \d+ of \d+ items on this shelf\.$/;

export function nothingCountedCheck(evidence: ScreenEvidence): Check {
  const title = 'Nothing on the screen counts or ranks what needs attention';
  const blocked = unreadable('SAF-5', title, evidence);
  if (blocked !== null) return blocked;
  const screenText = evidence.screenText as readonly string[];

  const offending = screenText.filter(
    (text) =>
      !SUBSET_LINE.test(text.trim()) && (BADGE.test(text.trim()) || COUNT_OF_TROUBLE.test(text)),
  );
  if (offending.length > 0) {
    return {
      id: 'SAF-5',
      title,
      status: 'FAIL',
      detail:
        `The screen carries ${JSON.stringify(offending[0] ?? '')}, which ranks or counts what is ` +
        "wrong. `02` refuses the aggregate, and which of two people's medicines matters more is " +
        'not a judgement this screen makes.',
    };
  }
  return {
    id: 'SAF-5',
    title,
    status: 'PASS',
    detail:
      `${String(screenText.length)} pieces of text on screen and none of them is a badge or a ` +
      'count of anything urgent.',
  };
}

// ---------------------------------------------------------------------------
// SAF-6 - a filter that matches nothing still says both things
// ---------------------------------------------------------------------------

export interface FilteredEvidence {
  readonly screenText: readonly string[] | null;
  /** How many items the shelf holds, so the subset line can be checked for what it should say. */
  readonly totalItems: number;
  /** The names that must not be on screen, because the filter excludes them. */
  readonly excludedNames: readonly string[];
}

/**
 * Filtering to a state nothing is in empties the list and changes nothing else.
 *
 * This is the state where somebody would most reasonably conclude that the shelf had been
 * cleared: they asked for the items needing action, and got a page with no items on it. The
 * coverage statement has to survive the filter, and the screen has to say that it is showing a
 * subset - `09`'s requirement does not lapse because a filter is on, and `18` forbids an absence
 * of findings reading as reassurance whichever way the absence arose.
 */
export function filteredEmptyCheck(evidence: FilteredEvidence): Check {
  const title = 'A filter that matches nothing still says it is a subset, and still qualifies it';
  if (evidence.screenText === null) {
    return {
      id: 'SAF-6',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The screen could not be read with the filter applied.',
    };
  }
  const screenText = evidence.screenText;

  const stillShown = evidence.excludedNames.filter((name) => says(screenText, name));
  if (stillShown.length > 0) {
    return {
      id: 'SAF-6',
      title,
      status: 'FAIL',
      detail:
        `${String(stillShown.length)} item(s) the filter excludes are still on screen, so the ` +
        'filter is decorative and a person cannot trust what it shows them.',
    };
  }
  if (!says(screenText, COVERAGE_SENTENCE)) {
    return {
      id: 'SAF-6',
      title,
      status: 'FAIL',
      detail:
        'The filtered screen dropped the coverage statement. An empty list under a filter is the ' +
        'easiest place in the app to read "nothing found" as "nothing to find".',
    };
  }
  const subset = `Showing 0 of ${String(evidence.totalItems)} items on this shelf.`;
  if (!says(screenText, subset)) {
    return {
      id: 'SAF-6',
      title,
      status: 'FAIL',
      detail:
        `The screen does not say ${JSON.stringify(subset)}, so a filtered page with no rows on ` +
        'it is indistinguishable from a shelf with nothing on it.',
    };
  }
  return {
    id: 'SAF-6',
    title,
    status: 'PASS',
    detail:
      `The list is empty, the screen says ${JSON.stringify(subset)}, and the coverage statement ` +
      'is still under it.',
  };
}
