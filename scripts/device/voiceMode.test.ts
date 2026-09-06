/**
 * The judgements the Voice Mode device scenario applies, tested without a device.
 *
 * Spec references: `19`, DEC-102 (a check that could not look reports `INCONCLUSIVE`), DEC-132 to
 * DEC-136.
 *
 * Every check here is asserted in both directions. A device check that can only pass is a device
 * check that has never found anything, and `DEV-046` is what happens when one of those is trusted.
 */

import { describe, it, expect } from 'vitest';
import {
  confirmationShownCheck,
  confirmationTargetsCheck,
  declinedCheck,
  entryControlCheck,
  noAdviceCheck,
  statedStateCheck,
  touchOnlyRefusalCheck,
  transcriptCheck,
  type Exchange,
  type MeasuredControl,
} from './voiceMode.js';

const DESTINATIONS = ['Today', 'Shelf', 'Safety', 'Care', 'You'];

function exchange(overrides: Partial<Exchange> = {}): Exchange {
  return { said: 'hello', transcript: ['hello'], summary: null, ...overrides };
}

describe('the way in', () => {
  it('passes when the control is on all five, in roughly the same place', () => {
    const found = new Map(DESTINATIONS.map((name, index) => [name, 200 + index * 8]));
    expect(entryControlCheck(found, DESTINATIONS).status).toBe('PASS');
  });

  it('fails when it is missing from one, and names which', () => {
    const found = new Map<string, number | null>(DESTINATIONS.map((name) => [name, 200]));
    found.set('Safety', null);
    const check = entryControlCheck(found, DESTINATIONS);
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('Safety');
  });

  it('fails when it moves between screens', () => {
    // A control a person has to look for on each screen is one they stop using.
    const found = new Map<string, number | null>(DESTINATIONS.map((name) => [name, 200]));
    found.set('You', 1400);
    expect(entryControlCheck(found, DESTINATIONS).status).toBe('FAIL');
  });
});

describe('the state', () => {
  it('passes when a state word is on screen', () => {
    expect(statedStateCheck(['Ready', 'Talk to Kynviora']).status).toBe('PASS');
  });

  it('fails when only a shape or a colour is carrying it', () => {
    expect(statedStateCheck(['○', 'Talk to Kynviora']).status).toBe('FAIL');
  });
});

describe('a request voice may not carry', () => {
  it('passes when it is refused out loud and nothing is armed', () => {
    expect(
      touchOnlyRefusalCheck(
        exchange({
          said: 'delete my account',
          transcript: ['delete my account', 'This one needs the screen rather than your voice.'],
        }),
      ).status,
    ).toBe('PASS');
  });

  it('fails when it is refused silently', () => {
    // A gate that refuses and says nothing leaves somebody waiting for an answer.
    expect(
      touchOnlyRefusalCheck(
        exchange({ said: 'delete my account', transcript: ['delete my account'] }),
      ).status,
    ).toBe('FAIL');
  });

  it('fails when a confirmation was armed for it', () => {
    // Armed means the proposal got past the voice gate, whatever the sentence says.
    expect(
      touchOnlyRefusalCheck(
        exchange({
          transcript: ['This one needs the screen rather than your voice.'],
          summary: 'Close your account.',
        }),
      ).status,
    ).toBe('FAIL');
  });
});

describe('the question it will not answer', () => {
  it('passes on the fixed sentence', () => {
    expect(
      noAdviceCheck(
        exchange({
          transcript: [
            'is it safe',
            'Anything about whether to take a medicine is for you and a health professional.',
          ],
        }),
      ).status,
    ).toBe('PASS');
  });

  it('fails on silence', () => {
    expect(noAdviceCheck(exchange({ transcript: ['is it safe'] })).status).toBe('FAIL');
  });

  it('fails when a forbidden phrase reaches the screen, even beside the right sentence', () => {
    // The failure this exists for is a fluent answer, not an absent one.
    const check = noAdviceCheck(
      exchange({
        transcript: [
          'is it safe',
          'It is safe. Anything about whether to take a medicine is for you and a health professional.',
        ],
      }),
    );
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('is safe');
  });
});

describe('the confirmation', () => {
  it('passes when the summary describes the request', () => {
    expect(
      confirmationShownCheck(
        exchange({
          summary: 'Open the camera, and guide you through photographing the front of the pack.',
        }),
        'front of the pack',
      ).status,
    ).toBe('PASS');
  });

  it('fails when nothing was rendered', () => {
    // A summary that exists in state and is not on screen is somebody agreeing to something they
    // were not shown.
    expect(confirmationShownCheck(exchange(), 'camera').status).toBe('FAIL');
  });

  it('fails when the summary is about something else', () => {
    expect(
      confirmationShownCheck(exchange({ summary: 'Remove this item from the shelf.' }), 'camera')
        .status,
    ).toBe('FAIL');
  });
});

describe('the two answers', () => {
  const big: readonly MeasuredControl[] = [
    { name: 'Yes, do that', widthDp: 320, heightDp: 92, gapAboveDp: null },
    { name: 'No, leave it', widthDp: 320, heightDp: 92, gapAboveDp: 16 },
  ];

  it('passes when both are large and separated', () => {
    expect(confirmationTargetsCheck(big).status).toBe('PASS');
  });

  it('fails when one is an ordinary-sized button', () => {
    expect(
      confirmationTargetsCheck([
        big[0] as MeasuredControl,
        { name: 'No, leave it', widthDp: 320, heightDp: 48, gapAboveDp: 16 },
      ]).status,
    ).toBe('FAIL');
  });

  it('fails when they are touching', () => {
    // A thumb reaching for one must not be able to graze the other.
    expect(
      confirmationTargetsCheck([
        big[0] as MeasuredControl,
        { name: 'No, leave it', widthDp: 320, heightDp: 92, gapAboveDp: 0 },
      ]).status,
    ).toBe('FAIL');
  });

  it('fails when they are named OK and Cancel', () => {
    // The same word to somebody who did not hear the question.
    expect(
      confirmationTargetsCheck([
        { name: 'OK', widthDp: 320, heightDp: 92, gapAboveDp: null },
        { name: 'Cancel', widthDp: 320, heightDp: 92, gapAboveDp: 16 },
      ]).status,
    ).toBe('FAIL');
  });

  it('reports inconclusive when one was never fully on screen', () => {
    // DEC-102: a check that could not look must not read as one that looked and was satisfied.
    expect(
      confirmationTargetsCheck([
        big[0] as MeasuredControl,
        { name: 'No, leave it', widthDp: null, heightDp: null, gapAboveDp: 16 },
      ]).status,
    ).toBe('INCONCLUSIVE');
  });
});

describe('saying no', () => {
  it('passes when the shelf is unchanged', () => {
    expect(declinedCheck(['a', 'b'], ['a', 'b']).status).toBe('PASS');
  });

  it('fails when something was written anyway', () => {
    expect(declinedCheck(['a', 'b'], ['a', 'b', 'c']).status).toBe('FAIL');
  });
});

describe('the transcript', () => {
  it('passes when two turns are on screen, both sides of each', () => {
    expect(
      transcriptCheck(
        exchange({
          said: 'is it safe',
          transcript: [
            'You said. open the shelf',
            'Kynviora said. Done.',
            'You said. is it safe',
            'Kynviora said. Anything about a medicine is for a health professional.',
          ],
        }),
        'open the shelf',
      ).status,
    ).toBe('PASS');
  });

  it('fails when the earlier turn was dropped, and names it', () => {
    const check = transcriptCheck(
      exchange({
        said: 'is it safe',
        transcript: ['You said. is it safe', 'Kynviora said. Done.'],
      }),
      'open the shelf',
    );
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('open the shelf');
  });

  it("fails when only the person's side is recorded", () => {
    // A transcript of questions with no answers is the useless half: somebody hard of hearing is
    // reading this **instead of** listening.
    const check = transcriptCheck(
      exchange({
        said: 'is it safe',
        transcript: ['You said. open the shelf', 'You said. is it safe'],
      }),
      'open the shelf',
    );
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('not');
  });

  it('reports inconclusive when the screen could not be read at all', () => {
    // DEC-102. A page that would not dump is not a page with nothing on it, and the first version
    // of this check reported three questions missing from a transcript that had all three.
    expect(transcriptCheck(exchange({ transcript: [] }), 'anything').status).toBe('INCONCLUSIVE');
  });
});
