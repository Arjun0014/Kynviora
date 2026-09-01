import { describe, it, expect } from 'vitest';
import {
  ACTION_URGENCIES,
  DELIVERY_CHANNELS,
  MAX_CHANNEL_FOR_URGENCY,
  REVALIDATION_OUTCOMES,
} from '@kynviora/domain';
import {
  CHANNEL_PRESENTATION,
  QUIET_HOURS_COPY,
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
