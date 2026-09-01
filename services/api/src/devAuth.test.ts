import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import {
  DEV_STEP_UP_HEADER,
  DEV_USER_HEADER,
  DevAuthRefused,
  createDevAuthenticator,
} from './devAuth.js';
import { instantFrom } from '@kynviora/domain';

/**
 * The development authenticator.
 *
 * This is a backdoor, and the only thing that makes it acceptable is that it fails closed in every
 * direction. Each of those directions is a test here, because the failure mode of a convenience
 * like this is not that it stops working - it is that it keeps working somewhere it should not.
 */

const NOW = instantFrom('2026-08-29T12:00:00.000Z');
const now = () => NOW;

const USER = '00000000-0000-4000-8000-00000000d001';

function requestWith(headers: Record<string, string | string[] | undefined>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

describe('it is off unless somebody turns it on', () => {
  it('is absent when the flag is unset', () => {
    expect(createDevAuthenticator({ now, enabled: undefined, nodeEnv: 'development' })).toBeNull();
  });

  it('is absent for any value other than exactly 1', () => {
    // "true", "yes" and "0" are all things somebody types expecting them to work. None of them
    // should, because a half-recognised flag is worse than an unrecognised one.
    for (const enabled of ['true', 'yes', '0', '', 'TRUE']) {
      expect(createDevAuthenticator({ now, enabled, nodeEnv: 'development' })).toBeNull();
    }
  });

  it('refuses to exist under NODE_ENV=production', () => {
    // A copied `.env` is the ordinary way a development flag reaches a deployment, so this throws
    // rather than warning: the process must not come up.
    expect(() => createDevAuthenticator({ now, enabled: '1', nodeEnv: 'production' })).toThrow(
      DevAuthRefused,
    );
  });
});

describe('what it will and will not accept', () => {
  const authenticate = createDevAuthenticator({ now, enabled: '1', nodeEnv: 'development' });

  it('is constructed in development', () => {
    expect(authenticate).not.toBeNull();
  });

  it('returns nobody when no header is present', async () => {
    // Deny by default. Absent is not "some default user".
    expect(await authenticate?.(requestWith({}))).toBeNull();
  });

  it('refuses anything that is not a UUID', async () => {
    // Otherwise the header becomes a way to put arbitrary text into `kynviora.user_id`, which is
    // interpolated into a session setting on every request.
    for (const value of ['admin', '1', "' OR 1=1 --", 'not-a-uuid', `${USER} `]) {
      expect(await authenticate?.(requestWith({ [DEV_USER_HEADER]: value }))).toBeNull();
    }
  });

  it('accepts a UUID and produces that principal', async () => {
    const principal = await authenticate?.(requestWith({ [DEV_USER_HEADER]: USER }));
    expect(principal?.userId).toBe(USER);
  });

  it('does not treat a session as stepped up unless asked', async () => {
    // Step-up gates publishing, withdrawal, export and caregiver administration. Handing it out
    // by default would make every one of those paths untestable in its refusing direction.
    const principal = await authenticate?.(requestWith({ [DEV_USER_HEADER]: USER }));
    expect(principal?.stepUpVerifiedAt).toBeNull();
  });

  it('grants step-up only on the separate header', async () => {
    const principal = await authenticate?.(
      requestWith({ [DEV_USER_HEADER]: USER, [DEV_STEP_UP_HEADER]: '1' }),
    );
    expect(principal?.stepUpVerifiedAt).toBe(NOW);
  });

  it('takes the first value when a header is repeated', async () => {
    const principal = await authenticate?.(requestWith({ [DEV_USER_HEADER]: [USER, 'other'] }));
    expect(principal?.userId).toBe(USER);
  });
});

describe('it hands out no authority beyond an identity', () => {
  const authenticate = createDevAuthenticator({ now, enabled: '1', nodeEnv: 'development' });

  it('produces a principal with nothing on it but a user and a step-up time', async () => {
    // `14`: admin and reviewer roles are not inferred from client claims, and a header is a client
    // claim. A dev principal is an ordinary user; the reviewer console still requires a row in
    // `reviewer`, and the API test for that asserts the seeded owner gets 404 from staff routes.
    const principal = await authenticate?.(requestWith({ [DEV_USER_HEADER]: USER }));
    expect(Object.keys(principal ?? {}).sort()).toEqual(['stepUpVerifiedAt', 'userId']);
  });

  it('ignores any role the caller tries to assert', async () => {
    const principal = await authenticate?.(
      requestWith({
        [DEV_USER_HEADER]: USER,
        'x-kynviora-dev-role': 'CLINICAL_SAFETY_LEAD',
        'x-kynviora-reviewer': '1',
      }),
    );
    expect(JSON.stringify(principal)).not.toContain('CLINICAL_SAFETY_LEAD');
  });
});
