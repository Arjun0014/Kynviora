import { describe, it, expect } from 'vitest';
import {
  ACTION_URGENCIES,
  DELIVERY_CHANNELS,
  MAX_CHANNEL_FOR_URGENCY,
  REVALIDATION_OUTCOMES,
} from '@kynviora/domain';
import {
  ALL_QUIET_HOURS_STRINGS,
  CHANNEL_PRESENTATION,
  QUIET_HOURS_COPY,
  URGENCY_CHANNEL_COPY,
  REVALIDATION_PRESENTATION,
  presentChannel,
  quietHoursLabel,
  revalidationNotice,
  urgencyChannelLines,
} from './notificationPolicy.js';

describe('what each channel says', () => {
  it('has a sentence for every channel in the vocabulary', () => {
    for (const channel of DELIVERY_CHANNELS) {
      const presentation = presentChannel(channel);
      expect(presentation.label.length).toBeGreaterThan(0);
      expect(presentation.description.length).toBeGreaterThan(0);
    }
  });

  it('says plainly that the quietest channel reaches no device', () => {
    // Exit criterion 1 as the sentence a person actually reads. "Fewer notifications" would be
    // the euphemism; "nothing reaches your device at all" is what is true.
    expect(CHANNEL_PRESENTATION.IN_APP_ONLY.description).toContain(
      'Nothing reaches your device at all',
    );
  });

  it('does not promise what a lock screen will say', () => {
    // `15` A6. The detail level decides that and it is a separate setting; a channel description
    // that described the content would be describing somebody else's dial.
    expect(CHANNEL_PRESENTATION.INTERRUPT.description).toContain('your own detail setting');
  });

  it('describes every urgency from the domain ceiling rather than restating it', () => {
    const lines = urgencyChannelLines(ACTION_URGENCIES);
    expect(lines.map((l) => l.urgency)).toEqual([...ACTION_URGENCIES]);
    for (const line of lines) {
      const expected = CHANNEL_PRESENTATION[MAX_CHANNEL_FOR_URGENCY[line.urgency]];
      expect(line.channelLabel).toBe(expected.label);
      expect(line.channelDescription).toBe(expected.description);
    }
  });
});

describe('the quiet hours copy', () => {
  it('says what quiet hours will not do', () => {
    // A person who believed it silenced everything would be relying on Kynviora for something it
    // will not do, and the exception is the half that gets left out.
    expect(QUIET_HOURS_COPY.exception).toContain('critical safety alert is still sent');
    expect(QUIET_HOURS_COPY.exception).toContain('will not wait until morning');
  });

  it('says nothing is being held where the local time is unknown', () => {
    // `DEV-030`. An empty state that read as "quiet hours are working" would be the wrong half of
    // the truth on the setting people rely on to be woken up.
    expect(QUIET_HOURS_COPY.unknownLocalTime).toContain('Nothing is being held back');
  });

  it('renders a window as a clock a person reads', () => {
    expect(quietHoursLabel(22 * 60, 7 * 60)).toBe('22:00 to 07:00');
    expect(quietHoursLabel(0, 30)).toBe('00:00 to 00:30');
    expect(quietHoursLabel(9 * 60 + 5, 17 * 60 + 45)).toBe('09:05 to 17:45');
  });

  it('normalises a minute from outside the day rather than rendering nonsense', () => {
    expect(quietHoursLabel(1440, 60)).toBe('00:00 to 01:00');
    expect(quietHoursLabel(-60, 60)).toBe('23:00 to 01:00');
  });
});

describe('what a stale notification says', () => {
  it('has a notice for every outcome that disarms the actions', () => {
    const disarming = REVALIDATION_OUTCOMES.filter((o) => o !== 'STILL_CURRENT');
    for (const outcome of disarming) {
      const notice = revalidationNotice(outcome);
      expect(notice).not.toBeNull();
      expect(notice?.heading.length).toBeGreaterThan(0);
      expect(notice?.body.length).toBeGreaterThan(0);
    }
  });

  it('says nothing at all when nothing changed', () => {
    // A screen announcing "still current" every time would train people to skip the notice on the
    // one occasion it says something else.
    expect(revalidationNotice('STILL_CURRENT')).toBeNull();
  });

  it('says nothing for an outcome it does not recognise', () => {
    // The domain decides actionability and this only describes it, so an unknown outcome has
    // already disarmed the controls. A sentence invented here could describe the wrong change.
    expect(revalidationNotice('SOMETHING_NEW')).toBeNull();
  });

  it('never tells anybody what to do about the medicine', () => {
    for (const outcome of Object.keys(REVALIDATION_PRESENTATION)) {
      const notice = REVALIDATION_PRESENTATION[outcome];
      const text = `${notice?.heading ?? ''} ${notice?.body ?? ''}`;
      // `09`. "There is nothing to act on" is about the alert, not about the pack.
      expect(text).not.toMatch(
        /(stop|start|keep) taking|throw (it|them) away|you should (stop|start|take)/i,
      );
    }
  });

  it('says where to look instead, on every one of them', () => {
    for (const outcome of Object.keys(REVALIDATION_PRESENTATION)) {
      const notice = REVALIDATION_PRESENTATION[outcome];
      const text = `${notice?.heading ?? ''} ${notice?.body ?? ''}`;
      // A screen whose controls vanished without a next step reads as one that broke.
      expect(text).toMatch(/nothing to act on|Open the item|receipt|ask the person/i);
    }
  });
});

describe('the words on the quiet-hours editor', () => {
  /**
   * The screen where somebody decides whether a phone lights up at three in the morning.
   *
   * Two sentences carry the weight: the exception, and the one saying this is not working yet.
   * Both are the kind a person only misses once.
   */

  it('says the format it will accept, on the field rather than after a refusal', () => {
    // Refused rather than repaired, so the field has to say what it wants before somebody types.
    expect(QUIET_HOURS_COPY.fieldHelp).toMatch(/24-hour/i);
    expect(QUIET_HOURS_COPY.fieldHelp).toMatch(/22:00/);
  });

  it('labels the two bounds as a window rather than as two settings', () => {
    expect(QUIET_HOURS_COPY.startLabel).toBe('From');
    expect(QUIET_HOURS_COPY.endLabel).toBe('Until');
  });

  it('says what turning them off means, rather than only that they are off', () => {
    expect(QUIET_HOURS_COPY.clearedNote).toMatch(/any time/i);
  });

  it('asks for confirmation before a change to when Kynviora may interrupt', () => {
    // `14`. The prompt is on the screen, not only enforced by a 403 the person cannot interpret.
    expect(QUIET_HOURS_COPY.stepUpPrompt).toMatch(/confirm/i);
  });

  it('tells a caregiver why they can see a setting they cannot change', () => {
    // `16`: a setting whose effect its holder cannot see is indistinguishable from a bug. They
    // read the window because it decides when *their* device stays quiet.
    expect(QUIET_HOURS_COPY.ownerOnly).toMatch(/your device/i);
  });

  it('never claims quiet hours silence everything', () => {
    // The one sentence a person must read before relying on them. Asserted over every string in
    // the module, so a later addition cannot quietly contradict it.
    for (const sentence of ALL_QUIET_HOURS_STRINGS) {
      expect(sentence, sentence).not.toMatch(
        /silences everything|nothing will arrive|no notifications at all will/i,
      );
    }
    expect(QUIET_HOURS_COPY.exception).toMatch(/critical safety alert is still sent/i);
  });

  it('confirms what was recorded rather than what will follow from it', () => {
    // `QUIET_HOURS_APPLIED` is `false` in this build, so "Kynviora will hold notifications during
    // that window" would be a promise it does not keep - made at the exact moment somebody has
    // just decided to rely on it. What was stored is the only thing the confirmation can claim.
    expect(QUIET_HOURS_COPY.savedNote).toMatch(/recorded/i);
    expect(QUIET_HOURS_COPY.savedNote).not.toMatch(/will hold|will not send|waits until/i);
  });

  it('says why an unreadable window has no editor, and that nothing changed', () => {
    // Both halves. Absent controls with no sentence read as a bug; a sentence about the controls
    // with nothing about the stored window leaves somebody wondering if saving cleared it.
    expect(QUIET_HOURS_COPY.unreadableWindow).toMatch(/cannot be changed here/i);
    expect(QUIET_HOURS_COPY.unreadableWindow).toMatch(/nothing has been altered/i);
  });

  it('says plainly that nothing is being held back while this does not work', () => {
    // `DEV-030` and `BLK-009`. "Not being applied yet" without "nothing is being held back" would
    // leave somebody unsure which direction the failure runs.
    expect(QUIET_HOURS_COPY.unknownLocalTime).toMatch(/not being applied/i);
    expect(QUIET_HOURS_COPY.unknownLocalTime).toMatch(/nothing is being held back/i);
  });
});

describe('the urgency table', () => {
  it('says it is not a control', () => {
    // `02`. A person who could raise every urgency to an interrupt would have rebuilt the alarm
    // optimisation the product refuses, one row at a time - so the copy says why there is no
    // switch rather than leaving somebody hunting for it.
    expect(URGENCY_CHANNEL_COPY.intro).toMatch(/rather than to be changed/i);
    expect(URGENCY_CHANNEL_COPY.intro).toMatch(/same for everybody/i);
  });

  it('states exit criterion 1 as a sentence a person reads', () => {
    // "A new foreign restriction does not automatically produce a red/high-severity personal
    // alert", in the words on the screen.
    expect(URGENCY_CHANNEL_COPY.foreignNote).toMatch(/kept in the app/i);
    expect(URGENCY_CHANNEL_COPY.foreignNote).toMatch(/not a personal alert/i);
  });

  it('never tells anybody what to do about a medicine', () => {
    // `09`, over the whole table including the channel descriptions it is built from.
    const sentences = [
      URGENCY_CHANNEL_COPY.heading,
      URGENCY_CHANNEL_COPY.intro,
      URGENCY_CHANNEL_COPY.foreignNote,
      ...urgencyChannelLines(ACTION_URGENCIES).flatMap((line) => [
        line.channelLabel,
        line.channelDescription,
      ]),
    ];

    for (const sentence of sentences) {
      expect(sentence, sentence).not.toMatch(
        /you should|we recommend|stop taking|keep taking|talk to your|is safe|is not safe/i,
      );
    }
  });
});
