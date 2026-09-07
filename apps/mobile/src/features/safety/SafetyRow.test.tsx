/**
 * What one line of the Safety screen says, and what it must never say.
 *
 * Spec references: `23` D-005 (evidence level and urgency are never combined) and D-014 (an
 * absence of a matched rule must never render as approval), `09` (a limitation travels with the
 * fact it qualifies), `18` (never present an absence of findings as reassurance; meaning is never
 * carried by colour alone), `02` (no score, no count, no ranking), DEC-045, DEC-130, DEC-138.
 *
 * WHY THIS EXISTS BESIDE `verify:device:safety`
 * The device scenario measures the state this build is actually in - every item `INSUFFICIENT_DATA`
 * with no publication - because that is the only state `BLK-006` allows to exist. The two rules it
 * is really about are conditional on a live alert, and there is no live alert to condition on, so
 * `SAF-2` and `SAF-4` are currently measuring the absent branch of both.
 *
 * This file measures the other branch. A line **with** an urgency and an evidence level is
 * unreachable on hardware today and is exactly where `23` D-005 fails first: three chips in a row
 * read as one compound verdict, and nothing on a device could notice until something is
 * publishable - by which time the screen has shipped.
 *
 * WHY IT IS NOT NEXT TO THE FILE IT TESTS
 * `src/app` is Expo Router's route directory and is enumerated with `require.context`, so every
 * file under it is bundled as a route. A `.test.tsx` there is bundled too, it imports
 * `react-test-renderer`, that is not a dependency of the app, and the phone shows Metro's red
 * error overlay instead of running (`DEV-054`).
 */

import { describe, it, expect } from 'vitest';
import { safetyInboxView, type SafetyInboxLineResponse } from '@kynviora/contracts';
import {
  allNodes,
  accessibleNameOf,
  hasName,
  press,
  renderScreen,
  textOf,
} from '../../../test/render.js';
import { SafetyRow } from '@/app/(tabs)/safety';

/**
 * The whole announcement a line with nothing to report has to carry.
 *
 * Written out rather than imported from `@kynviora/presentation`, for the same reason
 * `scripts/device/safetyInbox.ts` writes it out: a test that imported the constant would pass on
 * any wording the app happened to be shipping, including an edit that turned it into reassurance.
 * It would only be measuring that the screen and the package agree.
 */
const INSUFFICIENT_ANNOUNCEMENT =
  'Not enough information. Kynviora cannot check this item yet. Adding label or batch details ' +
  'would help.';

const NEVER_ASSESSED = 'Kynviora has not assessed this item.';

const NOTHING: SafetyInboxLineResponse = {
  ownedItemId: 'item-1',
  displayName: 'Synthetic Tablet A',
  alertPublicationId: null,
  state: 'INSUFFICIENT_DATA',
  urgency: null,
  evidenceLevel: null,
  lastAssessedAt: null,
  substances: [],
};

/** The state no shipped build can reach (`BLK-006`), which is where D-005 fails first. */
const ALERTED: SafetyInboxLineResponse = {
  ...NOTHING,
  alertPublicationId: 'pub-1',
  state: 'ACTION_REQUIRED',
  // Real members of both vocabularies. A value neither vocabulary has is narrowed by
  // `asActionUrgency` and `asEvidenceLevel` to the one that claims least, and a test written on
  // one would be measuring the fallback rather than the case it names.
  urgency: 'HIGH',
  evidenceLevel: 'B',
  lastAssessedAt: '2026-09-07T09:00:00.000Z',
};

/** What each of the two dimensions announces, so the merge test has two real strings to compare. */
const URGENCY_ANNOUNCEMENT = 'Act soon. Please take the recommended step.';
const EVIDENCE_ANNOUNCEMENT = 'Evidence: established guidance.';

function row(response: SafetyInboxLineResponse) {
  const opened: string[] = [];
  const view = safetyInboxView({ lines: [response], totalItems: 1 });
  const line = view.lines[0];
  if (line === undefined) throw new Error('the view dropped the line');
  const rendered = renderScreen(
    <SafetyRow
      line={line}
      onOpenLens={(substance) => opened.push(`lens:${substance.substanceKey}`)}
      onOpenAlert={(id) => opened.push(`alert:${id}`)}
    />,
  );
  return { rendered, opened };
}

/** Every accessible name the row draws, which is what a screen reader and `uiautomator` both see. */
function names(rendered: ReturnType<typeof row>['rendered']): readonly string[] {
  return allNodes(rendered)
    .map(accessibleNameOf)
    .filter((name) => name !== '');
}

describe('a line with nothing to report', () => {
  it('names the item, so an absence can never be rendered by leaving the row out', () => {
    // `23` D-014. The quietest way to render an absence as approval is omission, so the name being
    // on screen is the first thing this row is responsible for.
    expect(hasName(row(NOTHING).rendered, 'Synthetic Tablet A')).toBe(true);
  });

  it('announces the state with its qualification attached, not as a bare label', () => {
    // The chip is one accessibility node carrying the whole sentence. A row that announced only
    // "Not enough information" would be a label a person reads as a category rather than as a
    // limit on what Kynviora can say (`09`, `18`).
    expect(names(row(NOTHING).rendered)).toContain(INSUFFICIENT_ANNOUNCEMENT);
  });

  it('says the item has never been assessed rather than leaving the date blank', () => {
    // A blank where a date goes reads exactly like an item checked this morning.
    expect(textOf(row(NOTHING).rendered.renderer.root)).toContain(NEVER_ASSESSED);
  });

  it('offers no control to explain an alert that does not exist', () => {
    // DEC-045: absent, never disabled. A greyed-out control here states that an explanation exists
    // and is being withheld, which on a safety screen is a worse sentence than silence.
    expect(hasName(row(NOTHING).rendered, 'Why am I seeing this?')).toBe(false);
  });

  it('draws no urgency and no evidence block at all', () => {
    // Null together (`safetyInboxView`), and absent rather than defaulted: an item nobody has
    // alerted on has neither, and a chip reading `INFORMATIONAL` would be a claim nobody made.
    const drawn = names(row(NOTHING).rendered);
    expect(drawn).not.toContain('About this alert');
    expect(drawn).not.toContain('How soon');
    expect(drawn).not.toContain('How well established');
  });

  it('offers no Lens control where no substance was confirmed', () => {
    // Empty for every item until guided capture lands (`DEV-024`). A control opening an empty
    // answer is worse than no control.
    expect(hasName(row(NOTHING).rendered, { startsWith: 'How ' })).toBe(false);
  });
});

describe('a line with a live alert', () => {
  it('keeps urgency and evidence apart, each behind its own question', () => {
    // `23` D-005. Three chips in a row is how they get merged in practice - a person reads a strip
    // of adjacent chips as one compound verdict - so each sits under a label naming the question
    // it answers, and a sentence says neither answers the other.
    const drawn = names(row(ALERTED).rendered);
    expect(drawn).toContain('How soon');
    expect(drawn).toContain('How well established');
    expect(textOf(row(ALERTED).rendered.renderer.root)).toContain(
      'These are two separate things. Neither one answers the other.',
    );
  });

  it('never renders the two as one node', () => {
    // The failure this is really about: a single announcement carrying both would be the merged
    // visual D-005 forbids, arriving through the accessibility layer instead of the visual one -
    // which is what happens the moment somebody wraps the pair in one `accessible` container to
    // tidy up a screen reader's output.
    const drawn = names(row(ALERTED).rendered);
    expect(drawn).toContain(URGENCY_ANNOUNCEMENT);
    expect(drawn).toContain(EVIDENCE_ANNOUNCEMENT);
    const merged = drawn.filter(
      (name) => name.includes(URGENCY_ANNOUNCEMENT) && name.includes(EVIDENCE_ANNOUNCEMENT),
    );
    expect(merged).toEqual([]);
  });

  it('keeps the state itself a third statement, carrying neither of the other two', () => {
    // Three separate statements, not one verdict with two qualifiers folded into it. The state
    // says what Kynviora concluded; the other two say how soon and how well established, and a
    // state announcement that had absorbed either would be D-005 broken one layer up.
    const state = names(row(ALERTED).rendered).find((name) => name.startsWith('Action needed.'));
    expect(state).toBeDefined();
    expect(state).not.toContain(URGENCY_ANNOUNCEMENT);
    expect(state).not.toContain(EVIDENCE_ANNOUNCEMENT);
  });

  it('offers the explanation, and pressing it opens that publication', () => {
    const { rendered, opened } = row(ALERTED);
    expect(hasName(rendered, 'Why am I seeing this?')).toBe(true);
    press(rendered, 'Why am I seeing this?');
    expect(opened).toEqual(['alert:pub-1']);
  });
});

describe('every line', () => {
  it('carries no badge and no count of anything', () => {
    // `02`. A bare number is the shape a badge has, and no code path in this app could compute a
    // severity anyway - the rule engine is server-side (DEC-010).
    for (const response of [NOTHING, ALERTED]) {
      const bare = names(row(response).rendered).filter((name) => /^\(?\d{1,3}\)?$/.test(name));
      expect(bare).toEqual([]);
    }
  });

  it('says nothing that reads as approval', () => {
    // The one word this screen must never produce for a product. Asserted over the whole rendered
    // text rather than over a copy constant, because a row assembles several of those and a
    // combination can say what neither half said.
    for (const response of [NOTHING, ALERTED]) {
      const text = textOf(row(response).rendered.renderer.root).toLowerCase();
      expect(text).not.toContain('is safe');
      expect(text).not.toContain('no problem');
      expect(text).not.toContain('all clear');
    }
  });
});
