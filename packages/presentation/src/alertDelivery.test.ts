import { describe, it, expect } from 'vitest';
import {
  ALERT_DELIVERY_COPY,
  ALL_ALERT_DELIVERY_STRINGS,
  NOTIFICATION_LEVEL_DESCRIPTIONS,
  OWNER_CAP_NOTE,
  RESOLUTION_NOTE_WITHHELD,
  UNRESOLVED_LABEL,
  caregiverAlertLine,
  describeNotificationLevel,
  describeResolution,
  notificationSettingsView,
  previewNotification,
} from './alertDelivery.js';
import { findForbiddenClaims } from './copy.js';
import { NOTIFICATION_DETAIL_LEVELS } from '@kynviora/domain';

const PERSON = 'Parent A (synthetic)';
const MEDICINE = 'Synthetic Tablet A';

describe('notification level descriptions', () => {
  it('describes every level', () => {
    for (const level of NOTIFICATION_DETAIL_LEVELS) {
      const description = describeNotificationLevel(level);
      expect(description.label.length).toBeGreaterThan(0);
      expect(description.meaning.length).toBeGreaterThan(0);
    }
  });

  it('marks exactly the level that can name someone', () => {
    // The flag drives the warning on the settings screen, so it must agree with the behaviour.
    const revealing = NOTIFICATION_DETAIL_LEVELS.filter(
      (level) => NOTIFICATION_LEVEL_DESCRIPTIONS[level].revealsSubject,
    );
    expect(revealing).toEqual(['NAMED']);
  });

  it('agrees with what the domain actually renders', () => {
    // The preview is generated through the same function the dispatcher uses, so a description
    // claiming a level hides a name while the renderer prints one cannot survive.
    for (const level of NOTIFICATION_DETAIL_LEVELS) {
      const preview = previewNotification(level, {
        profileDisplayName: PERSON,
        itemDisplayName: MEDICINE,
      });
      const mentions = preview.includes(PERSON) || preview.includes(MEDICINE);
      expect(mentions).toBe(NOTIFICATION_LEVEL_DESCRIPTIONS[level].revealsSubject);
    }
  });

  it('never renders the preview placeholder identifier', () => {
    for (const level of NOTIFICATION_DETAIL_LEVELS) {
      expect(
        previewNotification(level, { profileDisplayName: PERSON, itemDisplayName: null }),
      ).not.toContain('preview');
    }
  });
});

describe('settings view', () => {
  it('marks levels above the owner ceiling as unavailable, without hiding them', () => {
    // A missing option is indistinguishable from a broken screen. Showing it marked is what makes
    // the ceiling explicable rather than mysterious.
    const view = notificationSettingsView({
      relationship: 'CAREGIVER',
      maxCaregiverDetail: 'CATEGORY',
      myPreference: 'CATEGORY',
      effective: 'CATEGORY',
    });
    expect(view.levels).toHaveLength(NOTIFICATION_DETAIL_LEVELS.length);
    expect(view.levels.filter((l) => l.unavailable).map((l) => l.level)).toEqual(['NAMED']);
  });

  it('marks nothing unavailable for the owner', () => {
    const view = notificationSettingsView({
      relationship: 'OWNER',
      maxCaregiverDetail: 'GENERIC',
      myPreference: 'NAMED',
      effective: 'NAMED',
    });
    expect(view.levels.some((l) => l.unavailable)).toBe(false);
    expect(view.capNote).toBeNull();
  });

  it('explains a reduced level rather than leaving it unexplained', () => {
    const view = notificationSettingsView({
      relationship: 'CAREGIVER',
      maxCaregiverDetail: 'GENERIC',
      myPreference: 'NAMED',
      effective: 'GENERIC',
    });
    expect(view.capNote).toBe(OWNER_CAP_NOTE);
  });

  it('adds no note when nothing was reduced', () => {
    const view = notificationSettingsView({
      relationship: 'CAREGIVER',
      maxCaregiverDetail: 'NAMED',
      myPreference: 'CATEGORY',
      effective: 'CATEGORY',
    });
    expect(view.capNote).toBeNull();
  });

  it('treats never having chosen as the generic default', () => {
    const view = notificationSettingsView({
      relationship: 'CAREGIVER',
      maxCaregiverDetail: 'NAMED',
      myPreference: null,
      effective: 'GENERIC',
    });
    expect(view.levels.find((l) => l.selected)?.level).toBe('GENERIC');
    expect(view.capNote).toBeNull();
  });
});

describe('resolution state', () => {
  it('labels every outcome the database permits', () => {
    for (const resolution of [
      'REVIEWED',
      'NOT_APPLICABLE',
      'RETURNED_OR_DISPOSED',
      'QUARANTINED',
      'DISCUSSED_WITH_PROFESSIONAL',
      'ITEM_IDENTITY_CORRECTED',
      'REPORTED_INCORRECT_MATCH',
    ]) {
      expect(describeResolution(resolution)).not.toBe('Resolved');
    }
  });

  it('says an unresolved alert is unresolved rather than leaving it blank', () => {
    expect(describeResolution(null)).toBe(UNRESOLVED_LABEL);
  });

  it('says a note was withheld rather than showing a blank', () => {
    // A blank reads as "there is no note", which is a different and misleading claim.
    const line = caregiverAlertLine({
      alertId: 'a',
      itemDisplayName: MEDICINE,
      resolution: 'REVIEWED',
      resolutionNote: null,
      resolutionNoteWithheld: true,
    });
    expect(line.noteLine).toBe(RESOLUTION_NOTE_WITHHELD);
  });

  it('shows nothing at all when there genuinely is no note', () => {
    const line = caregiverAlertLine({
      alertId: 'a',
      itemDisplayName: MEDICINE,
      resolution: 'REVIEWED',
      resolutionNote: null,
      resolutionNoteWithheld: false,
    });
    expect(line.noteLine).toBeNull();
  });

  it('never claims an alert is resolved when it is not', () => {
    const line = caregiverAlertLine({
      alertId: 'a',
      itemDisplayName: null,
      resolution: null,
      resolutionNote: null,
      resolutionNoteWithheld: false,
    });
    expect(line.resolved).toBe(false);
    expect(line.resolutionLabel).toBe(UNRESOLVED_LABEL);
  });
});

describe('copy', () => {
  it('contains no forbidden claim', () => {
    for (const text of ALL_ALERT_DELIVERY_STRINGS) {
      expect(findForbiddenClaims(text)).toEqual([]);
    }
  });

  it('says plainly that the two permissions are separate', () => {
    // 03 group H requires the separation; saying so is what makes it a choice rather than a
    // surprise.
    expect(ALERT_DELIVERY_COPY.separatePermissions).toMatch(/separate permissions/i);
  });

  it('does not claim a notification was read or acted on', () => {
    // The delivery log records what was sent. Presenting it as evidence of attention would be a
    // claim the system cannot support.
    expect(ALERT_DELIVERY_COPY.limitation).toMatch(/not a record of what was read/i);
  });

  it('distinguishes notification visibility from in-app access', () => {
    // The commonest misreading of this screen is that turning notifications down removes access.
    expect(ALERT_DELIVERY_COPY.settingsIntro).toMatch(/does not change what you can see/i);
  });

  it('does not shame or alarm', () => {
    for (const text of ALL_ALERT_DELIVERY_STRINGS) {
      expect(text).not.toMatch(/\b(failed|forgot|beware|risky|dangerous|warning:)\b/i);
    }
  });

  it('keeps every sentence short enough to read on a phone', () => {
    for (const text of ALL_ALERT_DELIVERY_STRINGS) {
      for (const sentence of text.split(/(?<=\.)\s+/)) {
        expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(22);
      }
    }
  });
});
