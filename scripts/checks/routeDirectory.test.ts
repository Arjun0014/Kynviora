/**
 * The rule, and then the real route directory measured against it.
 *
 * The last test is the one that matters, in the same way `mobileGlobals.test.ts`'s last test is:
 * it reads the actual `apps/mobile/src/app` tree, and it is the only thing in `npm run verify`
 * that would have caught a test file breaking the app's bundle (`DEV-054`).
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  NON_ROUTE_SUFFIXES,
  describeRouteDirectoryRule,
  filesUnder,
  isNonRouteFile,
  nonRouteFilesIn,
} from './routeDirectory.js';

const ROUTE_DIRECTORY = join(process.cwd(), 'apps', 'mobile', 'src', 'app');

describe('what counts as not-a-route', () => {
  it('names every suffix a test file uses here', () => {
    for (const suffix of NON_ROUTE_SUFFIXES) expect(isNonRouteFile(`Thing${suffix}`)).toBe(true);
  });

  it('leaves an ordinary route alone', () => {
    // A route is a `.tsx` and so is a test; only the suffix tells them apart, and a rule that
    // matched too widely would refuse the app's own screens.
    expect(isNonRouteFile('shelf.tsx')).toBe(false);
    expect(isNonRouteFile('_layout.tsx')).toBe(false);
    expect(isNonRouteFile('index.tsx')).toBe(false);
  });

  it('is not fooled by a name that merely contains the word', () => {
    expect(isNonRouteFile('latest.tsx')).toBe(false);
    expect(isNonRouteFile('testResults.tsx')).toBe(false);
  });

  it('finds one in a list', () => {
    expect(
      nonRouteFilesIn(['(tabs)/shelf.tsx', '(tabs)/ShelfRow.test.tsx', '_layout.tsx']),
    ).toEqual(['(tabs)/ShelfRow.test.tsx']);
  });

  it('explains the consequence rather than only the rule', () => {
    // The reason is the useful half: somebody who moves a test back needs to know the app stops
    // starting, not that a lint rule dislikes it.
    expect(describeRouteDirectoryRule()).toContain('does not start');
  });
});

describe('the route directory as it actually is', () => {
  it('exists where this check thinks it does', () => {
    // Without this the assertion below passes over a path that has moved, which is the same
    // trivially-true absence DEC-102 refuses everywhere else.
    expect(existsSync(ROUTE_DIRECTORY)).toBe(true);
  });

  it('contains routes and nothing else', () => {
    const offenders = nonRouteFilesIn(filesUnder(ROUTE_DIRECTORY, ROUTE_DIRECTORY));
    expect(offenders, describeRouteDirectoryRule()).toEqual([]);
  });
});
