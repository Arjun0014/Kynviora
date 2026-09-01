import { describe, it, expect } from 'vitest';
import {
  ANONYMOUS,
  ConfigRefused,
  DEV_STEP_UP_HEADER,
  DEV_USER_HEADER,
  SessionRefused,
  assertSessionAllowed,
  authHeaders,
  developmentSession,
  resolveApiConfig,
  resolveBaseUrl,
  resolveSession,
} from './config.js';

const USER = '00000000-0000-4000-8000-00000000d001';

describe('the base URL', () => {
  it('accepts https anywhere', () => {
    expect(resolveBaseUrl('https://api.kynviora.example/')).toBe('https://api.kynviora.example');
  });

  it('accepts plaintext on loopback only', () => {
    expect(resolveBaseUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(resolveBaseUrl('http://localhost:3000/')).toBe('http://localhost:3000');
  });

  it('refuses plaintext to a real host', () => {
    // `13` requires HTTPS. Health data over http on a network is exactly what that rule is for,
    // and loopback is the exception because there is no transport there to intercept.
    expect(() => resolveBaseUrl('http://api.kynviora.example')).toThrow(ConfigRefused);
    expect(() => resolveBaseUrl('http://192.168.1.9:3000')).toThrow(ConfigRefused);
  });

  it('refuses credentials in the URL', () => {
    // A URL reaches logs, crash reports and screenshots.
    expect(() => resolveBaseUrl('https://user:pass@api.kynviora.example')).toThrow(ConfigRefused);
  });

  it('refuses a non-URL and a non-http scheme', () => {
    expect(() => resolveBaseUrl('api.kynviora.example')).toThrow(ConfigRefused);
    expect(() => resolveBaseUrl('ftp://api.kynviora.example')).toThrow(ConfigRefused);
  });

  it('keeps only the origin', () => {
    expect(resolveBaseUrl('https://api.kynviora.example/v1/items?x=1')).toBe(
      'https://api.kynviora.example',
    );
  });
});

describe('configuration from the environment', () => {
  it('reads the public base URL', () => {
    const config = resolveApiConfig({ env: { EXPO_PUBLIC_API_BASE_URL: 'http://127.0.0.1:3000' } });
    expect(config.baseUrl).toBe('http://127.0.0.1:3000');
    expect(config.timeoutMs).toBeGreaterThan(0);
  });

  it('refuses to default to localhost when nothing is set', () => {
    // A client that quietly points at localhost in a shipped build fails in a way nobody can see
    // by reading the code.
    expect(() => resolveApiConfig({ env: {} })).toThrow(ConfigRefused);
    expect(() => resolveApiConfig({ env: { EXPO_PUBLIC_API_BASE_URL: '  ' } })).toThrow(
      ConfigRefused,
    );
  });

  it('reads only EXPO_PUBLIC_ names', () => {
    // `14`: nothing secret reaches a mobile bundle, and the prefix is what makes "is this shipped
    // to a phone?" answerable by reading the name.
    expect(() =>
      resolveApiConfig({ env: { KYNVIORA_API_BASE_URL: 'http://127.0.0.1:3000' } }),
    ).toThrow(ConfigRefused);
  });
});

describe('the session', () => {
  it('is anonymous when nothing is configured', () => {
    // An app with no identity configured is signed out, not signed in as somebody.
    expect(resolveSession({})).toEqual(ANONYMOUS);
    expect(resolveSession({ EXPO_PUBLIC_DEV_USER_ID: '' })).toEqual(ANONYMOUS);
  });

  it('sends no header at all when anonymous', () => {
    // Not a header with an empty value: the server treats an absent principal as unauthenticated,
    // and an empty header is an assertion of being nobody in particular.
    expect(authHeaders(ANONYMOUS)).toEqual({});
  });

  it('sends the development identity header', () => {
    expect(authHeaders(developmentSession(USER))).toEqual({ [DEV_USER_HEADER]: USER });
  });

  it('does not assert step-up by default', () => {
    // Step-up gates exports, caregiver administration and deletion (`14`). A client that always
    // asserts it turns those gates into decoration, because they could then only ever be
    // exercised in the satisfied direction.
    expect(authHeaders(developmentSession(USER))[DEV_STEP_UP_HEADER]).toBeUndefined();
    expect(authHeaders(developmentSession(USER, { stepUp: true }))[DEV_STEP_UP_HEADER]).toBe('1');
  });

  it('refuses a malformed user ID at construction', () => {
    // The API validates the header, so a bad one produces a 401 that reads like a broken session
    // rather than like a typo.
    expect(() => developmentSession('not-a-uuid')).toThrow(SessionRefused);
    expect(() => developmentSession('')).toThrow(SessionRefused);
  });
});

describe('the development identity refuses the same way the server does', () => {
  it('allows a development session against loopback', () => {
    expect(() =>
      assertSessionAllowed(developmentSession(USER), 'http://127.0.0.1:3000'),
    ).not.toThrow();
  });

  it('refuses a development session against a remote origin', () => {
    // `devAuth.ts` throws under NODE_ENV=production rather than warning, because a copied `.env`
    // is the ordinary way a development flag reaches a deployment. One side refusing is a
    // control; both sides refusing is a boundary.
    expect(() =>
      assertSessionAllowed(developmentSession(USER), 'https://api.kynviora.example'),
    ).toThrow(SessionRefused);
  });

  it('does not constrain an anonymous session', () => {
    // Being nobody is safe to be anywhere.
    expect(() => assertSessionAllowed(ANONYMOUS, 'https://api.kynviora.example')).not.toThrow();
  });
});
