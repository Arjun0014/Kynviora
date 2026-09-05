import { describe, it, expect } from 'vitest';
import { AUTH_FAILURES } from '@kynviora/domain';
import {
  ALL_AUTH_FAILURES,
  AUTH_REFUSAL_HEADING,
  RECOVERY_COPY,
  SIGN_IN_COPY,
  SIGN_OUT_COPY,
  SIGN_UP_COPY,
  authRefusal,
} from './auth.js';
import { findForbiddenClaims } from './copy.js';

/**
 * What a sign-in screen says.
 *
 * Spec references: `18` (familiar words first; a refusal says what to do about it; meaning never
 * carried by colour alone), `16` (say why a field is asked for), `13` (no oracle), `19`.
 *
 * WHY COPY IS TESTED AT ALL
 * Because `apps/**` is outside this run, so a sentence written in a component is one nothing
 * scans - and the sentences here are read by somebody who has just failed to get into their own
 * account, which is the worst moment to be vague at. What can be checked mechanically is checked
 * mechanically: that every failure has words, that none of them guesses, and that the two which
 * must not distinguish anything do not.
 */

describe('every failure has words', () => {
  it('covers the vocabulary exactly, with nothing invented and nothing missing', () => {
    // The guard that matters. A failure added to the domain vocabulary and not worded here would
    // reach a screen as `undefined`, which renders as a blank box under a heading saying
    // something went wrong.
    expect([...ALL_AUTH_FAILURES].sort()).toEqual([...AUTH_FAILURES].sort());
    for (const failure of AUTH_FAILURES) {
      const refusal = authRefusal(failure);
      expect(refusal, failure).toBeDefined();
      expect(refusal.message.length, failure).toBeGreaterThan(10);
    }
  });

  it('offers a next step wherever there is one to offer', () => {
    // `18`: a refusal that only says no is one somebody reads twice and acts on once. The single
    // exception is deliberate - new accounts being switched off is not something a person can do
    // anything about, and "try later" would be a guess dressed as advice.
    const withoutNextStep = AUTH_FAILURES.filter(
      (failure) => authRefusal(failure).nextStep === undefined,
    );
    expect(withoutNextStep).toEqual(['SIGNUP_DISABLED']);
  });

  it('marks a failure retryable only where trying the same thing again could work', () => {
    // Drives whether the screen offers the same button again. An unconfirmed address and an
    // already-registered one do not change by pressing harder.
    expect(authRefusal('WRONG_CREDENTIALS').retryable).toBe(true);
    expect(authRefusal('UNAVAILABLE').retryable).toBe(true);
    expect(authRefusal('EMAIL_UNCONFIRMED').retryable).toBe(false);
    expect(authRefusal('EMAIL_ALREADY_REGISTERED').retryable).toBe(false);
    expect(authRefusal('SESSION_EXPIRED').retryable).toBe(false);
  });
});

describe('what the refusals must not say', () => {
  it('never says which half of a credential was wrong', () => {
    // The provider does not distinguish them, and a screen that did would be an oracle for which
    // addresses have accounts - readable by anybody with a phone.
    const wrong = authRefusal('WRONG_CREDENTIALS');
    const text = `${wrong.message} ${wrong.nextStep ?? ''}`.toLowerCase();
    expect(text).not.toContain('no account');
    expect(text).not.toContain('not registered');
    expect(text).not.toContain("don't know");
    expect(text).not.toContain('do not know');
    expect(text).not.toContain('unknown email');
    // It is about the pair. "and" rather than "or" is the whole of the distinction.
    expect(wrong.message).toContain('do not go together');
  });

  it('never reads an outage as a wrong password', () => {
    const unavailable = authRefusal('UNAVAILABLE');
    expect(unavailable.message.toLowerCase()).not.toContain('password');
    expect(unavailable.message.toLowerCase()).toContain('could not reach');
  });

  it('says, on the recovery screen, that it is not telling you whether the address is known', () => {
    // The unusual one: the screen explains its own silence, because a person who gets no email
    // needs to know that "nothing arrived" does not mean "you typed it wrong".
    expect(RECOVERY_COPY.sentBody.toLowerCase()).toContain('if that address has');
    expect(RECOVERY_COPY.sentBody.toLowerCase()).toContain('we do not say');
  });
});

describe('the words themselves', () => {
  it('carries none of the forbidden safety claims', () => {
    // The same scan every other copy table gets. These screens are about accounts rather than
    // medicines, so it should pass trivially - which is why it is worth having: the day somebody
    // writes "safe" into a sign-in screen is the day it stops passing trivially.
    const everything = [
      ...Object.values(SIGN_IN_COPY),
      ...Object.values(SIGN_UP_COPY),
      ...Object.values(RECOVERY_COPY),
      ...Object.values(SIGN_OUT_COPY),
      ...AUTH_FAILURES.flatMap((f) => [authRefusal(f).message, authRefusal(f).nextStep ?? '']),
    ].join(' ');

    expect(findForbiddenClaims(everything)).toEqual([]);
  });

  it('says what signing out costs, before it happens', () => {
    // `12`: sign-out removes decrypted projections and caches. Somebody expecting to sign out and
    // still see their shelf offline is somebody who was not told.
    expect(SIGN_OUT_COPY.hint.toLowerCase()).toContain('every device');
    expect(SIGN_OUT_COPY.hint.toLowerCase()).toContain('removes the copy');
  });

  it('says why an email address is asked for', () => {
    // `16`: a field a person is asked for has a reason attached, and this one has three.
    expect(SIGN_UP_COPY.emailHelp.toLowerCase()).toContain('sign in');
    expect(SIGN_UP_COPY.emailHelp.toLowerCase()).toContain('nothing else');
  });

  it('has a heading over a refusal, not only a colour', () => {
    expect(AUTH_REFUSAL_HEADING.trim().length).toBeGreaterThan(0);
  });

  it('ends sign-up at a mailbox rather than pretending somebody is signed in', () => {
    // The state `kynviora-dev` is actually in: confirmation required, no session returned.
    expect(SIGN_UP_COPY.confirmationBody.toLowerCase()).toContain('open the link');
    expect(SIGN_UP_COPY.confirmationBody.toLowerCase()).toContain('come back and sign in');
  });
});
