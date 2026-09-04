/**
 * What may live in Expo Router's route directory, and what may not.
 *
 * Spec references: `12` (the client is a device), `19`, `DEV-043`, `DEV-054`.
 *
 * WHY THIS EXISTS
 * `apps/mobile/src/app` is enumerated by Expo Router with `require.context`, so **every** file
 * under it is a route and every file under it is bundled. Putting a `.test.tsx` there is therefore
 * not a tidy place to keep a test - it is a module the phone tries to load, importing
 * `react-test-renderer`, which is not a dependency of the app. The bundle fails, the phone shows
 * Metro's red overlay, and the app does not run at all (`DEV-054`).
 *
 * WHAT MAKES IT WORTH A CHECK RATHER THAN A NOTE
 * That no gate this project runs could see it. `npm run verify` typechecks, lints and runs 4000
 * tests without ever bundling the app, so all of them were green over a build that could not
 * start - which is `DEV-043`'s shape exactly, on the one tree that had just been given tests. The
 * failure surfaced eighteen minutes into a device run, as every check reporting `INCONCLUSIVE`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * Parse anything or ask Metro. The rule is about a filename in a directory, and the cheapest thing
 * that states it is the cheapest thing that can run on every commit.
 */

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Suffixes that make a file a test rather than a route. */
export const NON_ROUTE_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'] as const;

export function isNonRouteFile(fileName: string): boolean {
  return NON_ROUTE_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
}

/** Every file under `directory`, relative to `root`, depth-first. */
export function filesUnder(directory: string, root: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path, root));
    else found.push(relative(root, path));
  }
  return found;
}

/** The files in the route directory that are not routes. Empty is the only acceptable answer. */
export function nonRouteFilesIn(files: readonly string[]): readonly string[] {
  return files.filter((file) => isNonRouteFile(file));
}

export function describeRouteDirectoryRule(): string {
  return (
    'Expo Router bundles every file under `src/app`, so a test placed there is a module the ' +
    'phone tries to load. It imports `react-test-renderer`, the bundle fails, and the app does ' +
    'not start - with every other gate green, because none of them bundles the app (`DEV-054`).'
  );
}
