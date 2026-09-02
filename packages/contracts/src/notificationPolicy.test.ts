import { describe, it, expect } from 'vitest';
import { notificationPolicyView } from './views.js';
import type { NotificationSettingsResponse } from './client.js';

/**
 * The client half of `04` Phase 7.5.
 *
 * Every sentence arrives composed. What this layer decides is whether to offer the editor at all,
 * and the wrong answer costs somebody their quiet hours: an editor prefilled with nothing, saved,
 * clears a window that is set.
 */

function settings(
  overrides: Partial<NotificationSettingsResponse> = {},
): NotificationSettingsResponse {
  return {
    profileId: 'p1',
    relationship: 'OWNER',
    maxCaregiverDetail: 'GENERIC',
    myPreference: null,
    effectiveDetail: 'GENERIC',
    cappedByOwner: false,
    levels: ['NONE', 'GENERIC', 'NAMED'],
    quietHours: { startMinute: 1320, endMinute: 420 },
    quietHoursLabel: '22:00 to 07:00',
    quietHoursCopy: { heading: 'Quiet hours' },
    quietHoursApplied: false,
    urgencyChannels: [
      {
        urgency: 'CRITICAL',
        channelLabel: 'Sent to your device straight away',
        channelDescription: 'A notification arrives when this happens.',
      },
      {
        urgency: 'INFORMATIONAL',
        channelLabel: 'Kept in the app only',
        channelDescription: 'Nothing reaches your device at all.',
      },
    ],
    serverTime: '2026-09-02T12:00:00.000Z',
    ...overrides,
  };
}

describe('the window', () => {
  it('reads a window the server set', () => {
    const view = notificationPolicyView(settings());
    expect(view.quietHours).toEqual({ startMinute: 1320, endMinute: 420 });
    expect(view.quietHoursLabel).toBe('22:00 to 07:00');
    expect(view.quietHoursUnreadable).toBe(false);
  });

  it('reads no window as no window, and not as an unreadable one', () => {
    const view = notificationPolicyView(settings({ quietHours: null, quietHoursLabel: null }));
    expect(view.quietHours).toBeNull();
    expect(view.quietHoursUnreadable).toBe(false);
  });

  it('refuses to treat a window it cannot read as no window', () => {
    // The whole point of the third state. "No quiet hours are set" is a false statement when one
    // is, and an editor prefilled with nothing would clear it the moment somebody pressed save.
    for (const broken of [
      { startMinute: 1320, endMinute: 1320 },
      { startMinute: -1, endMinute: 420 },
      { startMinute: 1320, endMinute: 1440 },
      { startMinute: 22.5, endMinute: 420 },
      { startMinute: '22:00', endMinute: '07:00' },
    ]) {
      const view = notificationPolicyView(
        settings({ quietHours: broken as unknown as NotificationSettingsResponse['quietHours'] }),
      );
      expect(view.quietHours, JSON.stringify(broken)).toBeNull();
      expect(view.quietHoursUnreadable, JSON.stringify(broken)).toBe(true);
    }
  });

  it('keeps showing the label it could not parse the numbers of', () => {
    // The label is the server's sentence and is still true. Withholding it as well would tell
    // somebody nothing is set when something is.
    const view = notificationPolicyView(
      settings({
        quietHours: { startMinute: 1320, endMinute: 1320 },
        quietHoursLabel: '22:00 to 22:00',
      }),
    );
    expect(view.quietHoursUnreadable).toBe(true);
    expect(view.quietHoursLabel).toBe('22:00 to 22:00');
  });

  it('drops a label that is not a string', () => {
    const view = notificationPolicyView(
      settings({
        quietHoursLabel: 42 as unknown as NotificationSettingsResponse['quietHoursLabel'],
      }),
    );
    expect(view.quietHoursLabel).toBeNull();
  });
});

describe('whether the window does anything', () => {
  it('says so when the server says it does not', () => {
    // `DEV-030` and `BLK-009`. A person who set a window and believed it was working would be
    // relying on Kynviora for something it does not do - the `10` failure this codebase spends
    // the most care avoiding.
    expect(notificationPolicyView(settings()).quietHoursApplied).toBe(false);
  });

  it('follows the server when it says it does', () => {
    expect(notificationPolicyView(settings({ quietHoursApplied: true })).quietHoursApplied).toBe(
      true,
    );
  });

  it('assumes it does not where the server said nothing', () => {
    // The pessimistic reading is the safe one here: saying a window is not working when it is
    // costs a moment's confusion, and the opposite is a promise the build does not keep.
    for (const value of [undefined, null, 'yes', 1]) {
      const view = notificationPolicyView(
        settings({
          quietHoursApplied: value as unknown as NotificationSettingsResponse['quietHoursApplied'],
        }),
      );
      expect(view.quietHoursApplied, String(value)).toBe(false);
    }
  });
});

describe('the sentence saying the window does nothing yet', () => {
  it('is present where no window is set at all', () => {
    // The case a screen is most likely to get wrong, and the one that matters most: the person
    // about to set their first window is the one deciding to rely on quiet hours. Telling them
    // afterwards is telling them too late.
    const view = notificationPolicyView(settings({ quietHours: null, quietHoursLabel: null }));
    expect(view.quietHoursApplied).toBe(false);
    expect(view.limitationNote).toContain('Nothing is being held back');
  });

  it('is present where a window is set', () => {
    expect(notificationPolicyView(settings()).limitationNote).toContain('not being applied');
  });

  it('uses the wording the server sent, where it sent any', () => {
    const view = notificationPolicyView(
      settings({ quietHoursCopy: { unknownLocalTime: 'A newer sentence from the server.' } }),
    );
    expect(view.limitationNote).toBe('A newer sentence from the server.');
  });

  it('falls back to the packaged wording rather than to silence', () => {
    // A missing copy key must not become a screen that quietly implies quiet hours are working.
    // Silence here is indistinguishable from "it works", which is the one reading that is false.
    for (const copy of [{}, { unknownLocalTime: '' }, { unknownLocalTime: 42 }]) {
      const view = notificationPolicyView(
        settings({
          quietHoursCopy: copy as unknown as NotificationSettingsResponse['quietHoursCopy'],
        }),
      );
      expect(view.limitationNote, JSON.stringify(copy)).toContain('Nothing is being held back');
    }

    const missing = notificationPolicyView(
      settings({
        quietHoursCopy: undefined as unknown as NotificationSettingsResponse['quietHoursCopy'],
      }),
    );
    expect(missing.limitationNote).toContain('Nothing is being held back');
  });

  it('goes away when the server says the window does hold', () => {
    // The flip `DEV-030` describes. Nothing else has to change for the sentence to disappear.
    expect(notificationPolicyView(settings({ quietHoursApplied: true })).limitationNote).toBeNull();
  });
});

describe('who may change it', () => {
  it('lets the owner change it', () => {
    expect(notificationPolicyView(settings()).mayChangePolicy).toBe(true);
  });

  it('does not let a caregiver change it', () => {
    // They still read the window - `16`: somebody receiving nothing at 3am deserves to know a
    // window is doing that rather than a bug.
    const view = notificationPolicyView(settings({ relationship: 'CAREGIVER' }));
    expect(view.mayChangePolicy).toBe(false);
    expect(view.quietHoursLabel).toBe('22:00 to 07:00');
  });

  it('does not let a relationship it cannot read change it', () => {
    // Deny by default (`14`). Anything that is not the owner reads it and changes nothing.
    const view = notificationPolicyView(
      settings({
        relationship: 'SOMETHING_NEW' as unknown as NotificationSettingsResponse['relationship'],
      }),
    );
    expect(view.mayChangePolicy).toBe(false);
  });
});

describe('what reaches a device', () => {
  it('carries each urgency and what it does', () => {
    const view = notificationPolicyView(settings());
    expect(view.urgencyChannels.map((line) => line.urgency)).toEqual(['CRITICAL', 'INFORMATIONAL']);
    expect(view.urgencyChannels[1]?.channelLabel).toBe('Kept in the app only');
  });

  it('drops an urgency it cannot read rather than rendering its code', () => {
    // Trap 129, on a different screen: a code beside somebody's medicine is a field value, not a
    // phrase. Dropping the row loses a line; rendering `SOMETHING_NEW` puts one in front of them.
    const view = notificationPolicyView(
      settings({
        urgencyChannels: [
          { urgency: 'SOMETHING_NEW', channelLabel: 'x', channelDescription: 'y' },
          { urgency: 'CRITICAL', channelLabel: 'a', channelDescription: 'b' },
        ],
      }),
    );

    expect(view.urgencyChannels.map((line) => line.urgency)).toEqual(['CRITICAL']);
    expect(JSON.stringify(view)).not.toContain('SOMETHING_NEW');
  });

  it('survives a response that carries no table at all', () => {
    const view = notificationPolicyView(
      settings({
        urgencyChannels: undefined as unknown as NotificationSettingsResponse['urgencyChannels'],
      }),
    );
    expect(view.urgencyChannels).toEqual([]);
  });
});
