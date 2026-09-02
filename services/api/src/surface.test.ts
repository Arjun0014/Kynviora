import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createServer, registeredRoutePaths, type ApiSurface } from './server.js';
import type { DatabasePool, Principal } from './context.js';
import { instantFrom, noopLogger, unsafeId, type UserId } from '@kynviora/domain';
import type { SourceRegistryEntry } from '@kynviora/regulatory';

/**
 * The surface boundary.
 *
 * Spec references: `13` ("internal/admin APIs are separately authenticated/authorized and **not
 * exposed as user APIs**"), `14` (least privilege; staff roles never inferred from a claim),
 * `DEV-016`.
 *
 * WHY THE POOL THROWS
 * Every test here uses a pool that throws the moment anything touches it. That is the assertion:
 * a 404 from a surface that does not serve a path arrives *without a database round trip*, which
 * is what distinguishes an absent handler from a handler that checked and declined. Before the
 * split, the reviewer queue on the phone's origin reached a handler, opened a privileged
 * connection and read the `reviewer` table before answering. It now reaches nothing.
 *
 * WHY THE LISTS ARE DERIVED, NOT WRITTEN
 * The strongest test here does not name a route at all: it reads the paths the instance actually
 * registered and asserts the partition. A hand-written list of forbidden paths only ever covers
 * the routes whoever wrote it thought of, and the failure this guards against is a *new* route
 * registered on the wrong side.
 */

/** The wire envelope from `errors.ts`. Declared here so a shape change fails this file too. */
interface WireBody {
  readonly error: { readonly code: string; readonly message: string };
}

const NOW = instantFrom('2026-09-01T09:00:00.000Z');

/** A pool that fails loudly. Reaching it means a handler ran, which is the thing being disproved. */
const refusingPool: DatabasePool = {
  withUser: () => {
    throw new Error('A handler opened a user connection on a surface that should not serve it.');
  },
  withService: () => {
    throw new Error('A handler opened a service connection on a surface that should not serve it.');
  },
};

const REVIEWER: Principal = {
  userId: unsafeId<UserId>('00000000-0000-4000-8000-000000000001'),
  stepUpVerifiedAt: NOW,
};

const NO_SOURCES: ReadonlyMap<string, SourceRegistryEntry> = new Map<string, SourceRegistryEntry>();

function serverFor(surface: ApiSurface): FastifyInstance {
  return createServer({
    surface,
    pool: refusingPool,
    logger: noopLogger(),
    authenticate: (_request: FastifyRequest) => Promise.resolve(REVIEWER),
    now: () => NOW,
    loadSources: () => Promise.resolve(NO_SOURCES),
  });
}

let household: FastifyInstance;
let staff: FastifyInstance;

beforeAll(async () => {
  household = serverFor('HOUSEHOLD');
  staff = serverFor('STAFF');
  await household.ready();
  await staff.ready();
});

afterAll(async () => {
  await household.close();
  await staff.close();
});

/** The staff prefix. Every internal route lives under it and no household route may. */
const STAFF_PREFIX = '/v1/reviewer';

describe('the two surfaces partition the routes', () => {
  it('registers no staff path on the household surface', () => {
    const staffPaths = registeredRoutePaths(household).filter((path) =>
      path.startsWith(STAFF_PREFIX),
    );
    expect(staffPaths).toEqual([]);
  });

  it('registers no household path on the staff surface', () => {
    const householdPaths = registeredRoutePaths(staff).filter(
      (path) => path.startsWith('/v1/') && !path.startsWith(STAFF_PREFIX),
    );
    expect(householdPaths).toEqual([]);
  });

  it('serves every registered v1 path on exactly one surface', () => {
    const inHousehold = new Set(
      registeredRoutePaths(household).filter((p) => p.startsWith('/v1/')),
    );
    const inStaff = new Set(registeredRoutePaths(staff).filter((p) => p.startsWith('/v1/')));
    const both = [...inHousehold].filter((path) => inStaff.has(path));
    expect(both).toEqual([]);
    // Neither side is empty, so a partition is not being claimed over an app that registered
    // nothing - which is how this test would pass if `createServer` silently stopped working.
    expect(inHousehold.size).toBeGreaterThan(10);
    expect(inStaff.size).toBeGreaterThan(5);
  });

  it('serves health on both, because a process still has to say it is up', () => {
    expect(registeredRoutePaths(household)).toContain('/health');
    expect(registeredRoutePaths(staff)).toContain('/health');
  });
});

describe('a route on the wrong surface is absent, not refused', () => {
  const staffRequests = [
    { method: 'GET' as const, url: '/v1/reviewer/queue' },
    { method: 'GET' as const, url: '/v1/reviewer/operations' },
    { method: 'GET' as const, url: '/v1/reviewer/requests/00000000-0000-4000-8000-0000000000aa' },
    { method: 'POST' as const, url: '/v1/reviewer/requests' },
    { method: 'POST' as const, url: '/v1/reviewer/publication-block' },
    { method: 'POST' as const, url: '/v1/reviewer/shadow-runs' },
    { method: 'POST' as const, url: '/v1/reviewer/replays' },
  ];

  for (const { method, url } of staffRequests) {
    it('the household surface does not serve ' + method + ' ' + url, async () => {
      // The principal is a reviewer and the step-up is fresh, so nothing about *this caller*
      // explains the refusal. The origin does.
      const response = await household.inject(
        method === 'POST' ? { method, url, payload: {} } : { method, url },
      );
      expect(response.statusCode).toBe(404);
      expect(response.json<WireBody>().error.code).toBe('NOT_FOUND');
    });
  }

  const householdRequests = [
    { method: 'GET' as const, url: '/v1/profiles' },
    // `04` Phase 1.2. The two routes that make a person exist are household routes, and a staff
    // origin that served them would let a reviewer account create the records it reviews.
    { method: 'POST' as const, url: '/v1/households' },
    { method: 'POST' as const, url: '/v1/profiles' },
    { method: 'GET' as const, url: '/v1/items?profileId=00000000-0000-4000-8000-0000000000bb' },
    { method: 'GET' as const, url: '/v1/alerts' },
    { method: 'GET' as const, url: '/v1/caregiver-grants' },
    { method: 'GET' as const, url: '/v1/visit-packs/candidates' },
    { method: 'POST' as const, url: '/v1/dose-events' },
    { method: 'POST' as const, url: '/v1/reconciliations' },
  ];

  for (const { method, url } of householdRequests) {
    it('the staff surface does not serve ' + method + ' ' + url, async () => {
      const response = await staff.inject(
        method === 'POST' ? { method, url, payload: {} } : { method, url },
      );
      expect(response.statusCode).toBe(404);
      expect(response.json<WireBody>().error.code).toBe('NOT_FOUND');
    });
  }

  it('answers a wrong-surface path exactly as it answers an unknown one', async () => {
    const wrongSurface = await household.inject({ method: 'GET', url: '/v1/reviewer/queue' });
    const nonsense = await household.inject({ method: 'GET', url: '/v1/no-such-thing' });

    // `19` forbids an enumeration oracle. A staff route answering "that exists elsewhere" would
    // tell an attacker on the phone's origin that a reviewer console is deployed.
    expect(wrongSurface.statusCode).toBe(nonsense.statusCode);
    expect(wrongSurface.json<WireBody>().error.code).toBe(nonsense.json<WireBody>().error.code);
    expect(wrongSurface.json<WireBody>().error.message).toBe(
      nonsense.json<WireBody>().error.message,
    );
  });
});

describe('the safety inbox is a household route', () => {
  it('is served by the household surface', () => {
    expect(registeredRoutePaths(household)).toContain('/v1/profiles/:profileId/safety-inbox');
  });

  it('is not served by the staff surface', () => {
    // It had sat in the staff registration block since Phase 7.1, grouped by proximity rather
    // than by boundary. Nothing caught it because both surfaces were one origin.
    expect(registeredRoutePaths(staff)).not.toContain('/v1/profiles/:profileId/safety-inbox');
  });
});
