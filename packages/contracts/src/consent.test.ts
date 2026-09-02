import { describe, it, expect } from 'vitest';
import { CONSENT_PURPOSES } from '@kynviora/domain';
import { CONSENT_COPY } from '@kynviora/presentation';
import { consentRowView, consentView } from './consent.js';
import type { ConsentStandingLine, ConsentsResponse } from './client.js';

/**
 * `04` Phase 1.4's client half.
 *
 * Every sentence arrives composed. What this layer decides is which control a screen may offer and
 * which sentence goes beside it - and the wrong answer is a person believing they turned something
 * off.
 */

function line(overrides: Partial<ConsentStandingLine> = {}): ConsentStandingLine {
  return {
    purpose: 'NOTIFICATIONS',
    granted: true,
    everAnswered: true,
    policyVersion: '2026-09-02.1',
    recordedAt: '2026-09-01T09:00:00.000Z',
    enforcement: 'ENFORCED',
    optional: true,
    stale: false,
    ...overrides,
  };
}

function response(consents: readonly ConsentStandingLine[]): ConsentsResponse {
  return {
    policyVersion: '2026-09-02.1',
    consents,
    serverTime: '2026-09-02T12:00:00.000Z',
  };
}

describe('one purpose, as a row', () => {
  it('renders the words rather than the code', () => {
    const row = consentRowView(line());
    expect(row).not.toBeNull();
    expect(row?.label).toBe('Sending notifications to your device');
    expect(row?.purpose).toBe('NOTIFICATIONS');
    expect(row?.label).not.toMatch(/_/);
    expect(row?.description.length).toBeGreaterThan(0);
  });

  it('always carries what withdrawing it stops', () => {
    // Never empty and never optimistic: this is the sentence a person reads before pressing.
    for (const purpose of CONSENT_PURPOSES) {
      const row = consentRowView(line({ purpose }));
      expect(row?.withdrawalEffect.length, purpose).toBeGreaterThan(0);
    }
  });

  it('drops a purpose it has never heard of rather than showing its code', () => {
    // Trap 129, and worse here than elsewhere: a switch whose meaning nobody can state is not a
    // choice. A later version recording a new purpose must not put a bare code on this screen.
    expect(consentRowView(line({ purpose: 'SOMETHING_NEW' }))).toBeNull();
  });
});

describe('which switch a screen may offer', () => {
  it('offers no control for the one the product cannot run without', () => {
    const row = consentRowView(line({ purpose: 'PROFILE_DATA', enforcement: 'REQUIRED' }));
    expect(row?.mayChoose).toBe(false);
    // And says why, rather than showing a switch that would refuse (DEC-045).
    expect(row?.withdrawalEffect).toMatch(/cannot work without/i);
  });

  it('marks the two that actually stop something', () => {
    for (const purpose of ['NOTIFICATIONS', 'CAREGIVER_SHARING']) {
      const row = consentRowView(line({ purpose, enforcement: 'ENFORCED' }));
      expect(row?.enforcesSomething, purpose).toBe(true);
      expect(row?.notYetNote, purpose).toBeNull();
    }
  });

  it('says out loud when a switch stops nothing yet', () => {
    // `10`. Somebody who turned off "analytics" believing they had stopped something would have
    // been told a comforting untruth by a switch.
    const row = consentRowView(
      line({ purpose: 'DIAGNOSTICS_ANALYTICS', enforcement: 'NOTHING_TO_STOP' }),
    );
    expect(row?.enforcesSomething).toBe(false);
    expect(row?.notYetNote).toBe(CONSENT_COPY.notYetNote);
  });

  it('assumes a switch stops nothing where the server said something it cannot read', () => {
    // The pessimistic reading is the safe one. Telling somebody a switch may not do anything when
    // it does costs a moment's confusion; the opposite lets them believe they stopped something.
    for (const enforcement of ['SOMETHING_ELSE', '', 'enforced']) {
      const row = consentRowView(line({ enforcement }));
      expect(row?.enforcesSomething, enforcement).toBe(false);
      expect(row?.mayChoose, enforcement).toBe(true);
      expect(row?.notYetNote, enforcement).toBe(CONSENT_COPY.notYetNote);
    }
  });

  it('names the control after what pressing it does', () => {
    // "Agree" where nothing is in force, "Turn this off" where something is. A button naming the
    // setting rather than the action is how somebody turns off the thing they meant to turn on.
    expect(consentRowView(line({ granted: false }))?.actionLabel).toBe(CONSENT_COPY.grantLabel);
    expect(consentRowView(line({ granted: true }))?.actionLabel).toBe(CONSENT_COPY.withdrawLabel);
  });

  it('offers no control at all for the required purpose', () => {
    const row = consentRowView(line({ purpose: 'PROFILE_DATA', enforcement: 'REQUIRED' }));
    expect(row?.actionLabel).toBeNull();
    expect(row?.statusLabel).toBe(CONSENT_COPY.requiredLabel);
  });

  it('marks the rows that stop nothing and leaves the working ones unmarked', () => {
    // The chip is what lets somebody tell the two that matter from the five that do not, without
    // reading seven paragraphs. A chip on all seven would say nothing.
    expect(consentRowView(line({ enforcement: 'ENFORCED' }))?.statusLabel).toBeNull();
    expect(consentRowView(line({ enforcement: 'NOTHING_TO_STOP' }))?.statusLabel).toBe(
      CONSENT_COPY.notYetLabel,
    );
  });

  it('reads granted as the exact boolean', () => {
    // A truthy value arriving over the wire must not become agreement (`14`).
    for (const value of [undefined, null, 'true', 1, 'yes']) {
      const row = consentRowView(
        line({ granted: value as unknown as ConsentStandingLine['granted'] }),
      );
      expect(row?.granted, String(value)).toBe(false);
    }
  });
});

describe('what the row says about the answer itself', () => {
  it('says an unanswered purpose is treated as not agreed', () => {
    const row = consentRowView(line({ everAnswered: false, granted: false }));
    expect(row?.neverAnsweredNote).toBe(CONSENT_COPY.neverAnsweredNote);
  });

  it('says nothing of the sort to somebody who answered no', () => {
    // Having said no is an answer. Telling them they have not answered would be wrong about the
    // one thing this screen exists to record.
    const row = consentRowView(line({ everAnswered: true, granted: false }));
    expect(row?.neverAnsweredNote).toBeNull();
  });

  it('flags a standing answer recorded against an older policy', () => {
    const row = consentRowView(line({ stale: true }));
    expect(row?.staleNote).toBe(CONSENT_COPY.staleNote);
  });

  it('never calls an unanswered purpose stale', () => {
    // Asking somebody to re-confirm something they never confirmed.
    const row = consentRowView(line({ stale: true, everAnswered: false }));
    expect(row?.staleNote).toBeNull();
  });
});

describe('the whole list', () => {
  it('renders every purpose the server reports', () => {
    const view = consentView(response(CONSENT_PURPOSES.map((purpose) => line({ purpose }))));
    expect(view.rows.map((row) => row.purpose)).toEqual([...CONSENT_PURPOSES]);
    expect(view.policyVersion).toBe('2026-09-02.1');
  });

  it('counts how many optional switches stop nothing here', () => {
    // Not a warning: the answer to "why do so few of these matter yet".
    const view = consentView(
      response([
        line({ purpose: 'PROFILE_DATA', enforcement: 'REQUIRED' }),
        line({ purpose: 'NOTIFICATIONS', enforcement: 'ENFORCED' }),
        line({ purpose: 'CAREGIVER_SHARING', enforcement: 'ENFORCED' }),
        line({ purpose: 'DIAGNOSTICS_ANALYTICS', enforcement: 'NOTHING_TO_STOP' }),
        line({ purpose: 'RESEARCH_PROGRAMME', enforcement: 'NOTHING_TO_STOP' }),
      ]),
    );
    expect(view.notYetCount).toBe(2);
    // The required one is not counted among them: it is not a switch at all.
    expect(view.rows.filter((row) => row.mayChoose)).toHaveLength(4);
  });

  it('survives a response carrying nothing', () => {
    const view = consentView(response([]));
    expect(view.rows).toEqual([]);
    expect(view.notYetCount).toBe(0);
  });

  it('keeps the purposes it knows when the server sends one it does not', () => {
    // Dropping the unknown one must not drop the list.
    const view = consentView(
      response([line({ purpose: 'WHAT_IS_THIS' }), line({ purpose: 'NOTIFICATIONS' })]),
    );
    expect(view.rows.map((row) => row.purpose)).toEqual(['NOTIFICATIONS']);
    expect(JSON.stringify(view)).not.toContain('WHAT_IS_THIS');
  });

  it('reports no policy version rather than inventing one', () => {
    const view = consentView({
      ...response([]),
      policyVersion: undefined as unknown as string,
    });
    expect(view.policyVersion).toBe('');
  });
});
