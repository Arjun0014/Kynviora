import { describe, it, expect } from 'vitest';
import { act } from 'react-test-renderer';
import {
  AUTH_REFUSAL_HEADING,
  AUTH_UNCONFIGURED_COPY,
  RECOVERY_COPY,
  SIGN_IN_COPY,
  SIGN_UP_COPY,
  authRefusal,
} from '@kynviora/presentation';
import type { AuthTokens, SignUpResult } from '@kynviora/contracts';
import { AuthProvider, type AuthContextValue } from '@/auth/AuthProvider';
import { flush, hasName, press, renderScreen, screenNames } from '../../../test/render.js';
import { SignInScreen } from './SignInScreen';

/**
 * The only screen a signed-out person can reach.
 *
 * Spec references: `18` (one primary action per screen; a refusal says what to do next; a control
 * that cannot succeed is not offered twice), `13` (branch on codes, never on message text), `19`,
 * DEC-118, DEC-125.
 *
 * WHAT IS WORTH A RENDER TEST HERE
 * Not the words - `packages/presentation/src/auth.test.ts` has those, and it can check every
 * failure rather than the four a screen test would bother with. What needs a tree is the
 * **branching**: that a sign-up which needs a confirmation ends at a mailbox rather than at an
 * error, that a recovery request says the same thing whatever the address was, and that the two
 * ways out of a failed sign-in are both on screen at the moment somebody needs them.
 */

const TOKENS: AuthTokens = {
  accessToken: 'header.payload.signature',
  refreshToken: 'a-refresh-token',
  expiresAtSeconds: 4_102_444_800,
};

interface Recorded {
  readonly signIns: { email: string; password: string }[];
  readonly signUps: { email: string; password: string }[];
  readonly recoveries: string[];
}

function auth(overrides: Partial<AuthContextValue> = {}): {
  value: AuthContextValue;
  recorded: Recorded;
} {
  const recorded: Recorded = { signIns: [], signUps: [], recoveries: [] };
  const value: AuthContextValue = {
    state: 'SIGNED_OUT',
    tokens: null,
    signIn: (email, password) => {
      recorded.signIns.push({ email, password });
      return Promise.resolve({ kind: 'OK' as const, value: TOKENS });
    },
    signUp: (email, password) => {
      recorded.signUps.push({ email, password });
      return Promise.resolve({
        kind: 'OK' as const,
        value: { state: 'CONFIRMATION_REQUIRED' } satisfies SignUpResult,
      });
    },
    recover: (email) => {
      recorded.recoveries.push(email);
      return Promise.resolve({ kind: 'OK' as const, value: 'SENT_IF_KNOWN' as const });
    },
    reauthenticate: () => Promise.resolve({ kind: 'OK' as const, value: TOKENS }),
    signOut: () => Promise.resolve(),
    sessionLost: () => undefined,
    ...overrides,
  };
  return { value, recorded };
}

function screen(overrides: Partial<AuthContextValue> = {}) {
  const { value, recorded } = auth(overrides);
  const rendered = renderScreen(
    <AuthProvider value={value}>
      <SignInScreen />
    </AuthProvider>,
  );
  return { ...rendered, recorded };
}

/** Type into a field by its accessible name. */
function type(rendered: ReturnType<typeof screen>, name: string, text: string): void {
  const input = rendered.renderer.root
    .findAll((node) => node.props['accessibilityLabel'] === name)
    .at(0);
  if (input === undefined) throw new Error(`No field named ${name}`);
  const onChangeText = input.props['onChangeText'] as (value: string) => void;
  // Inside `act`, or the re-render never happens and the next press runs against a callback
  // closed over the previous, empty, state - which is a test measuring its own helper.
  act(() => {
    onChangeText(text);
  });
}

describe('signing in', () => {
  it('offers the two other ways out beside the one that failed', async () => {
    // The reason this is one screen and not three routes: a person who has just been told their
    // password is wrong is one tap from asking for a link, with no navigation in between.
    const rendered = screen();
    await flush();
    const names = screenNames(rendered);
    expect(names).toContain(SIGN_IN_COPY.submitLabel);
    expect(names).toContain(SIGN_IN_COPY.createLabel);
    expect(names).toContain(SIGN_IN_COPY.forgotLabel);
  });

  it('will not submit an empty form', async () => {
    // `18`: an action that cannot succeed is not offered as if it could. Pressing it must reach
    // nothing, because a refusal from the provider over a blank field is a round trip that tells
    // somebody what the form already knew.
    const rendered = screen();
    await flush();
    press(rendered, SIGN_IN_COPY.submitLabel);
    await flush();
    expect(rendered.recorded.signIns).toEqual([]);
  });

  it('sends what was typed', async () => {
    const rendered = screen();
    await flush();
    type(rendered, SIGN_IN_COPY.emailLabel, 'person@example.test');
    type(rendered, SIGN_IN_COPY.passwordLabel, 'a-password');
    press(rendered, SIGN_IN_COPY.submitLabel);
    await flush();
    expect(rendered.recorded.signIns).toEqual([
      { email: 'person@example.test', password: 'a-password' },
    ]);
  });

  it('shows the refusal with its next step, under a heading and not only a colour', async () => {
    const rendered = screen({
      signIn: () => Promise.resolve({ kind: 'FAILED', reason: 'WRONG_CREDENTIALS' }),
    });
    await flush();
    type(rendered, SIGN_IN_COPY.emailLabel, 'person@example.test');
    type(rendered, SIGN_IN_COPY.passwordLabel, 'wrong');
    press(rendered, SIGN_IN_COPY.submitLabel);
    await flush();

    const refusal = authRefusal('WRONG_CREDENTIALS');
    expect(hasName(rendered, AUTH_REFUSAL_HEADING)).toBe(true);
    expect(hasName(rendered, refusal.message)).toBe(true);
    expect(hasName(rendered, refusal.nextStep ?? '')).toBe(true);
  });

  it('reports a dropped connection as one, not as a wrong password', async () => {
    const rendered = screen({
      signIn: () => Promise.resolve({ kind: 'FAILED', reason: 'UNAVAILABLE' }),
    });
    await flush();
    type(rendered, SIGN_IN_COPY.emailLabel, 'person@example.test');
    type(rendered, SIGN_IN_COPY.passwordLabel, 'a-password');
    press(rendered, SIGN_IN_COPY.submitLabel);
    await flush();
    expect(hasName(rendered, authRefusal('UNAVAILABLE').message)).toBe(true);
    expect(hasName(rendered, authRefusal('WRONG_CREDENTIALS').message)).toBe(false);
  });

  it('does not crash when the provider throws', async () => {
    // `DEV-055`'s rule on the one screen where it matters most: an uncaught rejection here is a
    // crash banner over the only way into the app.
    const rendered = screen({ signIn: () => Promise.reject(new Error('boom')) });
    await flush();
    type(rendered, SIGN_IN_COPY.emailLabel, 'person@example.test');
    type(rendered, SIGN_IN_COPY.passwordLabel, 'a-password');
    press(rendered, SIGN_IN_COPY.submitLabel);
    await flush();
    expect(hasName(rendered, authRefusal('UNAVAILABLE').message)).toBe(true);
  });
});

describe('creating an account', () => {
  it('ends at a mailbox rather than at an error when confirmation is required', async () => {
    // What `kynviora-dev` actually does. A screen rendering "no session" as a failure would send
    // somebody to try again at an account they have just this second made - and the next attempt
    // says the address is already registered.
    const rendered = screen();
    await flush();
    press(rendered, SIGN_IN_COPY.createLabel);
    await flush();
    type(rendered, SIGN_UP_COPY.emailLabel, 'new@example.test');
    type(rendered, SIGN_UP_COPY.passwordLabel, 'a-long-enough-password');
    press(rendered, SIGN_UP_COPY.submitLabel);
    await flush();

    expect(hasName(rendered, SIGN_UP_COPY.confirmationHeading)).toBe(true);
    expect(hasName(rendered, SIGN_UP_COPY.confirmationBody)).toBe(true);
    // And no refusal anywhere on it.
    expect(hasName(rendered, AUTH_REFUSAL_HEADING)).toBe(false);
  });

  it('says why the address is being asked for', async () => {
    // `16`. Only on the sign-up form, because that is where the field is new.
    const rendered = screen();
    await flush();
    press(rendered, SIGN_IN_COPY.createLabel);
    await flush();
    expect(hasName(rendered, SIGN_UP_COPY.emailHelp)).toBe(true);
  });
});

describe('asking for a new password', () => {
  it('asks for no password, and says the answer is the same either way', async () => {
    const rendered = screen();
    await flush();
    press(rendered, SIGN_IN_COPY.forgotLabel);
    await flush();
    expect(screenNames(rendered)).not.toContain(SIGN_IN_COPY.passwordLabel);

    type(rendered, RECOVERY_COPY.emailLabel, 'person@example.test');
    press(rendered, RECOVERY_COPY.submitLabel);
    await flush();

    expect(rendered.recorded.recoveries).toEqual(['person@example.test']);
    expect(hasName(rendered, RECOVERY_COPY.sentHeading)).toBe(true);
    expect(hasName(rendered, RECOVERY_COPY.sentBody)).toBe(true);
  });

  it('forgets a refusal when the question changes', async () => {
    // A refusal about a password is not about an email address, and leaving it on screen while
    // somebody asks a different question is telling them the new one failed too.
    const rendered = screen({
      signIn: () => Promise.resolve({ kind: 'FAILED', reason: 'WRONG_CREDENTIALS' }),
    });
    await flush();
    type(rendered, SIGN_IN_COPY.emailLabel, 'person@example.test');
    type(rendered, SIGN_IN_COPY.passwordLabel, 'wrong');
    press(rendered, SIGN_IN_COPY.submitLabel);
    await flush();
    expect(hasName(rendered, AUTH_REFUSAL_HEADING)).toBe(true);

    press(rendered, SIGN_IN_COPY.forgotLabel);
    await flush();
    expect(hasName(rendered, AUTH_REFUSAL_HEADING)).toBe(false);
  });
});

describe('a build with no sign-in service', () => {
  it('says so instead of offering a form that cannot work', async () => {
    const rendered = screen({ state: 'UNCONFIGURED' });
    await flush();
    expect(hasName(rendered, AUTH_UNCONFIGURED_COPY.heading)).toBe(true);
    expect(screenNames(rendered)).not.toContain(SIGN_IN_COPY.submitLabel);
  });
});
