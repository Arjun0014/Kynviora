import { describe, it, expect } from 'vitest';
import {
  CONSENT_ENFORCEMENT,
  CONSENT_POLICY_VERSION,
  CONSENT_PURPOSES,
  DEFAULT_CONSENT_LOCALE,
  consentEnforcement,
  consentStateFrom,
  isConsentPurpose,
  isGranted,
  isOptionalConsent,
  normalizeConsentDecision,
  type ConsentReceipt,
} from './index.js';

/**
 * `04` Phase 1.4 - consent as a product state.
 *
 * The exit criterion is about behaviour, not about a record. `consent_receipt` has existed since
 * migration `0002` and nothing had ever read it, which is a consent *log*; what makes it a state
 * is that something checks it and that the screen can say which purposes actually stop anything.
 */

function receipt(overrides: Partial<ConsentReceipt> = {}): ConsentReceipt {
  return {
    purpose: 'NOTIFICATIONS',
    granted: true,
    policyVersion: CONSENT_POLICY_VERSION,
    locale: 'en-IN',
    recordedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('the purposes', () => {
  it('agrees with the constraint the database enforces', () => {
    // Migration `0002`'s `consent_purpose_valid`, transcribed. A purpose the domain offers and the
    // database refuses is a switch somebody flips that cannot be saved.
    expect([...CONSENT_PURPOSES]).toEqual([
      'PROFILE_DATA',
      'CAREGIVER_SHARING',
      'NOTIFICATIONS',
      'DIAGNOSTICS_ANALYTICS',
      'DOCUMENT_IMAGE_PROCESSING',
      'CATALOG_CONTRIBUTION',
      'CONNECTED_HEALTH_DATA',
      'RESEARCH_PROGRAMME',
    ]);
    for (const purpose of CONSENT_PURPOSES) expect(isConsentPurpose(purpose), purpose).toBe(true);
    for (const other of ['MARKETING', 'notifications', '', 'PROFILE']) {
      expect(isConsentPurpose(other), other).toBe(false);
    }
  });

  it('says for every purpose whether withdrawing it stops anything', () => {
    // A total record over the vocabulary, so a purpose added later fails here rather than shipping
    // as a switch nobody has decided the meaning of.
    for (const purpose of CONSENT_PURPOSES) {
      expect(['ENFORCED', 'NOTHING_TO_STOP', 'REQUIRED'], purpose).toContain(
        consentEnforcement(purpose),
      );
    }
    expect(Object.keys(CONSENT_ENFORCEMENT).sort()).toEqual([...CONSENT_PURPOSES].sort());
  });

  it('enforces exactly the two this build can enforce', () => {
    // Notifications and caregiver sharing change what `selectRecipients` does. The rest govern
    // behaviour this build does not have - no analytics, no OCR (`BLK-007`), no connected health,
    // no research programme, and a manual entry never reaches the shared catalog by construction.
    const enforced = CONSENT_PURPOSES.filter((p) => consentEnforcement(p) === 'ENFORCED');
    expect([...enforced].sort()).toEqual(['CAREGIVER_SHARING', 'NOTIFICATIONS']);
  });

  it('offers a choice about everything except the one the product cannot run without', () => {
    expect(isOptionalConsent('PROFILE_DATA')).toBe(false);
    for (const purpose of CONSENT_PURPOSES) {
      if (purpose === 'PROFILE_DATA') continue;
      expect(isOptionalConsent(purpose), purpose).toBe(true);
    }
  });
});

describe('what is in force', () => {
  it('treats an absent receipt as not granted', () => {
    // Deny by default (`14`). Silence is not agreement, and treating it as agreement is the single
    // failure `16` exists to prevent.
    const state = consentStateFrom([]);
    expect(state).toHaveLength(CONSENT_PURPOSES.length);
    for (const standing of state) {
      expect(standing.granted, standing.purpose).toBe(false);
      expect(standing.everAnswered, standing.purpose).toBe(false);
    }
  });

  it('tells "never answered" apart from "answered no"', () => {
    // Different facts, and a screen that showed the same thing for both would tell somebody they
    // had declined something they were never asked.
    const state = consentStateFrom([receipt({ granted: false })]);
    const notifications = state.find((s) => s.purpose === 'NOTIFICATIONS');
    const analytics = state.find((s) => s.purpose === 'DIAGNOSTICS_ANALYTICS');

    expect(notifications?.granted).toBe(false);
    expect(notifications?.everAnswered).toBe(true);
    expect(analytics?.granted).toBe(false);
    expect(analytics?.everAnswered).toBe(false);
  });

  it('lets the newest receipt win', () => {
    const state = consentStateFrom([
      receipt({ granted: true, recordedAt: '2026-09-01T10:00:00.000Z' }),
      receipt({ granted: false, recordedAt: '2026-09-02T10:00:00.000Z' }),
    ]);
    expect(isGranted(state, 'NOTIFICATIONS')).toBe(false);
  });

  it('does not depend on the order rows arrive in', () => {
    const state = consentStateFrom([
      receipt({ granted: false, recordedAt: '2026-09-02T10:00:00.000Z' }),
      receipt({ granted: true, recordedAt: '2026-09-01T10:00:00.000Z' }),
    ]);
    expect(isGranted(state, 'NOTIFICATIONS')).toBe(false);
  });

  it('resolves a tie against Kynviora', () => {
    // Two receipts at the same instant is a state nothing writes, and picking one would be
    // inventing an order. The withdrawal wins, because a person who both granted and withdrew at
    // the same moment has said something the product must not resolve in its own favour.
    const at = '2026-09-01T10:00:00.000Z';
    expect(
      isGranted(
        consentStateFrom([
          receipt({ granted: true, recordedAt: at }),
          receipt({ granted: false, recordedAt: at }),
        ]),
        'NOTIFICATIONS',
      ),
    ).toBe(false);
    expect(
      isGranted(
        consentStateFrom([
          receipt({ granted: false, recordedAt: at }),
          receipt({ granted: true, recordedAt: at }),
        ]),
        'NOTIFICATIONS',
      ),
    ).toBe(false);
  });

  it('ignores a purpose it does not recognise rather than failing', () => {
    // A receipt for a purpose a later version wrote is not a reason to stop reporting the ones
    // this build understands.
    const state = consentStateFrom([receipt({ purpose: 'SOMETHING_NEW' }), receipt()]);
    expect(state).toHaveLength(CONSENT_PURPOSES.length);
    expect(isGranted(state, 'NOTIFICATIONS')).toBe(true);
    expect(JSON.stringify(state)).not.toContain('SOMETHING_NEW');
  });

  it('says when a standing answer predates the current policy', () => {
    const stale = consentStateFrom([receipt({ policyVersion: '2020-01-01.1' })]);
    expect(stale.find((s) => s.purpose === 'NOTIFICATIONS')?.stale).toBe(true);

    const current = consentStateFrom([receipt()]);
    expect(current.find((s) => s.purpose === 'NOTIFICATIONS')?.stale).toBe(false);
  });

  it('does not call an unanswered purpose stale', () => {
    // An unanswered purpose is not a stale one, and saying otherwise would ask somebody to
    // re-confirm something they never confirmed.
    const state = consentStateFrom([]);
    for (const standing of state) expect(standing.stale, standing.purpose).toBe(false);
  });

  it('does not treat the required purpose as granted just because it is required', () => {
    // "Required" is a statement about what the product needs, not a licence to assume an answer.
    expect(isGranted(consentStateFrom([]), 'PROFILE_DATA')).toBe(false);
  });
});

describe('recording a decision', () => {
  it('takes a purpose and an answer', () => {
    const result = normalizeConsentDecision({ purpose: 'NOTIFICATIONS', granted: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.purpose).toBe('NOTIFICATIONS');
    expect(result.value.granted).toBe(false);
    expect(result.value.locale).toBe(DEFAULT_CONSENT_LOCALE);
  });

  it('refuses a purpose it does not know', () => {
    // A receipt naming a purpose nothing can enforce is a record of agreement to something
    // undefined, which is worse than no record.
    for (const purpose of ['MARKETING', '', 'notifications']) {
      const result = normalizeConsentDecision({ purpose, granted: true });
      expect(result.ok, purpose).toBe(false);
      if (!result.ok) expect(result.error.detail?.['field'], purpose).toBe('purpose');
    }
  });

  it('refuses an answer that is not the exact boolean', () => {
    // "Yes" and "on" are not answers to a consent question, and a truthy value arriving over the
    // wire must not become agreement.
    for (const granted of ['true', 1, null, undefined]) {
      const result = normalizeConsentDecision({
        purpose: 'NOTIFICATIONS',
        granted: granted as unknown as boolean,
      });
      expect(result.ok, String(granted)).toBe(false);
      if (!result.ok) expect(result.error.detail?.['field'], String(granted)).toBe('granted');
    }
  });

  it('refuses to withdraw the purpose the product cannot run without', () => {
    // A switch whose only outcome is a refusal is a control that should not be offered (DEC-045),
    // and a route that accepted it would write a receipt saying something untrue.
    const result = normalizeConsentDecision({ purpose: 'PROFILE_DATA', granted: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detail?.['reason_code']).toBe('consent_required');
      // And it says what the person would actually need instead, rather than only refusing.
      expect(result.error.reason).toMatch(/removing your data/i);
    }
  });

  it('still lets the required purpose be granted', () => {
    expect(normalizeConsentDecision({ purpose: 'PROFILE_DATA', granted: true }).ok).toBe(true);
  });

  it('records the language the policy was read in', () => {
    // `16` asks for consent state to be localizable: which text somebody read is part of what
    // they agreed to.
    const result = normalizeConsentDecision({
      purpose: 'NOTIFICATIONS',
      granted: true,
      locale: 'ml-IN',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.locale).toBe('ml-IN');
  });

  it('refuses a locale that is obviously not one', () => {
    const result = normalizeConsentDecision({
      purpose: 'NOTIFICATIONS',
      granted: true,
      locale: 'Malayalam',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail?.['field']).toBe('locale');
  });

  it('has no field for a policy version, a user or a time', () => {
    // A client that could name the policy version it agreed to could record agreement to a text
    // nobody showed them, and a client-set timestamp is an audit trail written by the thing being
    // audited.
    const result = normalizeConsentDecision({
      purpose: 'NOTIFICATIONS',
      granted: true,
      policyVersion: '1999-01-01.1',
      userId: 'somebody-else',
      recordedAt: '1999-01-01T00:00:00.000Z',
    } as unknown as Parameters<typeof normalizeConsentDecision>[0]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value).sort()).toEqual(['granted', 'locale', 'purpose']);
    expect(JSON.stringify(result.value)).not.toContain('1999');
    expect(JSON.stringify(result.value)).not.toContain('somebody-else');
  });
});
