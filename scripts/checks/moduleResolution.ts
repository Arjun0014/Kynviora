/**
 * How a `@kynviora/*` import is resolved when the suite runs, and why it is not resolved from
 * `tsconfig` `paths`.
 *
 * Spec references: `04` Phase 0.3 (one CI gate over the whole graph), `24` (a gate whose red
 * results are not acted on is not a gate), DEC-102, `DEV-096`, trap 208.
 *
 * WHY THIS EXISTS
 * `resolve.tsconfigPaths: true` puts Rolldown's native resolver into tsconfig **auto-discovery**
 * (`ResolveOptions { tsconfig: Some(Auto) }`), and auto-discovery is a filesystem walk **per
 * specifier, keyed on the importing file**. The walk begins at the importing file itself, so its
 * first candidate is `<the importing file>/tsconfig.json` - a path that can never exist, whose
 * miss the walk has to classify as an IO error every single time in order to carry on up to the
 * root. Those walks run on Rolldown's own thread pool rather than on the JavaScript thread, so
 * how many are in flight at once is a function of how many Vitest workers are asking for modules
 * at once. At twelve workers the classification stopped being reliable and about one run in two
 * failed one to four suites with `Tsconfig not found <a source file>\tsconfig.json` - a
 * **transform** failure, never an assertion, over files that compile in under a second alone
 * (`DEV-096`).
 *
 * WHAT REPLACED IT
 * Nothing, because nothing was needed. Every `@kynviora/*` package is an npm workspace: it is
 * symlinked into `node_modules/@kynviora/`, its manifest is named after the specifier, and its
 * entry point is the same `src/index.ts` file the `paths` entry names. `apps/mobile` had been
 * proving that for weeks - it imports four of these packages a hundred and fifty times over and
 * its Vitest project has never had `tsconfigPaths` or an alias for any of them.
 *
 * WHAT THIS CHECK IS ACTUALLY GUARDING
 * Not the flag. The flag is one line and somebody could re-add it, which is why the last test
 * reads the real configuration - but the thing that would hurt is quieter: `npm run typecheck`
 * resolves these specifiers through `tsconfig.base.json`'s `paths`, and the suite now resolves
 * them through the workspace. Those are two answers to the same question, and if they ever
 * disagree the tests run against code the typechecker never looked at. So the check compares
 * them, entry by entry, over the specifiers the repository actually imports.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * Resolve anything itself. Reimplementing Node's algorithm here would put a third answer beside
 * the two it is meant to compare. It reads what each side *declares* - a `paths` target, and a
 * manifest's `name` plus `exports`/`main` - and asserts those name the same file on disk.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';

/** The prefix every workspace-internal specifier carries. */
export const WORKSPACE_SCOPE = '@kynviora/';

/** A `paths` entry, reduced to the one target this repository ever declares. */
export interface PathEntry {
  /** The specifier as written in an import, e.g. `@kynviora/domain`. */
  readonly specifier: string;
  /** Repo-relative target, POSIX-separated, e.g. `packages/domain/src/index.ts`. */
  readonly target: string;
  /** True for a wildcard entry such as `@kynviora/domain/*`. */
  readonly wildcard: boolean;
}

/**
 * The `compilerOptions.paths` of a parsed tsconfig, as entries.
 *
 * A `paths` value is an array because TypeScript allows fallbacks; this repository declares
 * exactly one target for each, and an entry that declared more than one would mean the two sides
 * being compared here could not be compared at all, so it is refused rather than flattened.
 */
export function pathEntriesOf(tsconfig: unknown): readonly PathEntry[] {
  const paths = (tsconfig as { compilerOptions?: { paths?: unknown } })?.compilerOptions?.paths;
  if (paths === undefined) return [];
  if (typeof paths !== 'object' || paths === null) throw new TypeError('paths is not an object');

  return Object.entries(paths as Record<string, unknown>).map(([specifier, targets]) => {
    if (!Array.isArray(targets) || targets.length !== 1 || typeof targets[0] !== 'string') {
      throw new TypeError(`paths entry ${specifier} does not declare exactly one target`);
    }
    const wildcard = specifier.endsWith('/*');
    return { specifier, target: targets[0], wildcard };
  });
}

/**
 * Every `@kynviora/...` specifier a source file actually imports.
 *
 * Only specifier **positions** count - after `from`, after `import`, and inside `import(...)` or
 * `require(...)` - because the question is which specifiers a resolver has to answer, and a
 * package name inside a message, an assertion or a comment is not one of those. It does not
 * parse; `mobileGlobals.ts` explains why a check like this stops short of pretending to be a type
 * system. What it can miss is a specifier built at runtime, which nothing here does and which no
 * bundler could resolve either.
 */
export function workspaceSpecifiersIn(source: string): readonly string[] {
  const found = new Set<string>();
  const pattern = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"](@kynviora\/[A-Za-z0-9_./-]+)['"]/g;
  for (const match of source.matchAll(pattern)) found.add(match[1] as string);
  return [...found].sort();
}

/** A specifier's package part: `@kynviora/domain/thing` -> `@kynviora/domain`. */
export function packageOf(specifier: string): string {
  const parts = specifier.slice(WORKSPACE_SCOPE.length).split('/');
  return WORKSPACE_SCOPE + (parts[0] as string);
}

/** True when a specifier reaches past the package's own entry point. */
export function isSubpath(specifier: string): boolean {
  return specifier !== packageOf(specifier);
}

/** The shape of a workspace package manifest, as far as this check reads it. */
export interface Manifest {
  readonly name?: unknown;
  readonly main?: unknown;
  readonly exports?: unknown;
}

/**
 * The file a manifest promises for its **bare** specifier, repo-relative and POSIX-separated,
 * or `null` when it promises none.
 *
 * `exports['.']` wins over `main` because a resolver that understands `exports` stops there; a
 * manifest that declares both and disagrees with itself is the interesting case and is returned
 * as whichever a resolver would take.
 */
export function manifestEntryPoint(manifest: Manifest, packageDir: string): string | null {
  const exports = manifest.exports;
  const fromExports =
    typeof exports === 'string'
      ? exports
      : typeof exports === 'object' && exports !== null
        ? (exports as Record<string, unknown>)['.']
        : undefined;
  const declared = typeof fromExports === 'string' ? fromExports : manifest.main;
  if (typeof declared !== 'string') return null;
  return posix.normalize(posix.join(toPosix(packageDir), declared));
}

/**
 * The file a manifest promises for a **subpath** specifier, or `null` when it promises none.
 *
 * Only the one wildcard form these manifests use is understood (`"./*": "./src/*.ts"`). Anything
 * else returns `null`, which the test reads as "this side cannot answer", never as agreement.
 */
export function manifestSubpathTarget(
  manifest: Manifest,
  packageDir: string,
  subpath: string,
): string | null {
  const exports = manifest.exports;
  if (typeof exports !== 'object' || exports === null) return null;
  const wildcard = (exports as Record<string, unknown>)['./*'];
  if (typeof wildcard !== 'string' || !wildcard.includes('*')) return null;
  return posix.normalize(posix.join(toPosix(packageDir), wildcard.replace('*', subpath)));
}

/**
 * True when a resolved Vite/Vitest configuration turns tsconfig path resolution on anywhere in
 * it - at the root, inside a project, or inside an environment.
 *
 * The search is structural rather than a lookup at one known key, because the option is legal in
 * several places and the failure it caused does not care which one put it there.
 */
export function enablesTsconfigPaths(value: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (node: unknown): boolean => {
    if (typeof node !== 'object' || node === null) return false;
    if (seen.has(node)) return false;
    seen.add(node);
    if (Array.isArray(node)) return node.some(walk);
    const record = node as Record<string, unknown>;
    if (record['tsconfigPaths'] === true) return true;
    return Object.values(record).some(walk);
  };
  return walk(value);
}

/** `\` is not a path separator in any of the files this check compares. */
export function toPosix(path: string): string {
  return path.replaceAll('\\', '/');
}

/** Read and parse a JSON file relative to the repository root. */
export function readJson(repoRoot: string, relativePath: string): unknown {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), 'utf8')) as unknown;
}

/**
 * Directories that hold somebody else's code, or output rather than source.
 *
 * The same list `eslint.config.js` ignores and `.gitignore` refuses: `android/` and `ios/` are
 * written by `expo prebuild` and `.expo/` by the router, so a specifier found in one of them
 * would be a specifier nobody wrote.
 */
const NOT_SOURCE = new Set(['node_modules', 'dist', '.expo', '.git', 'android', 'ios']);

/** A scanned source file and the workspace specifiers it imports. */
export interface ScannedFile {
  /** Repo-relative, POSIX-separated. */
  readonly path: string;
  readonly specifiers: readonly string[];
}

/**
 * Every TypeScript source file under the named repository-relative roots, with the workspace
 * specifiers it imports.
 *
 * `apps/mobile` carries its own `node_modules`, so skipping by name rather than only at the root
 * is what keeps this reading the repository rather than its dependencies.
 */
export function sourceFilesUnder(
  repoRoot: string,
  roots: readonly string[],
): readonly ScannedFile[] {
  const found: ScannedFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (NOT_SOURCE.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        found.push({
          path: toPosix(relative(resolve(repoRoot), path)),
          specifiers: workspaceSpecifiersIn(readFileSync(path, 'utf8')),
        });
      }
    }
  };
  for (const root of roots) {
    const path = join(repoRoot, root);
    if (existsSync(path)) visit(path);
  }
  return found;
}
