/**
 * The rule, and then the real repository measured against it.
 *
 * The tests under "the repository as it actually is" are the ones that matter. The first of them
 * reads the configuration the suite is running under and would fail if `tsconfigPaths` came back
 * (`DEV-096`); the rest compare, entry by entry, the two answers to "where does
 * `@kynviora/domain` live?" - the one `npm run typecheck` uses and the one the suite now uses -
 * because a disagreement between those two is tests running over code the typechecker never saw.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import vitestConfig from '../../vitest.config.js';
import {
  WORKSPACE_SCOPE,
  enablesTsconfigPaths,
  isSubpath,
  manifestEntryPoint,
  manifestSubpathTarget,
  packageOf,
  pathEntriesOf,
  readJson,
  sourceFilesUnder,
  workspaceSpecifiersIn,
  type Manifest,
} from './moduleResolution.js';

const REPO_ROOT = process.cwd();

describe('what a tsconfig `paths` map says', () => {
  it('reads a specifier, its target, and whether it is a wildcard', () => {
    expect(
      pathEntriesOf({
        compilerOptions: {
          paths: { '@k/one': ['packages/one/src/index.ts'], '@k/one/*': ['packages/one/src/*'] },
        },
      }),
    ).toEqual([
      { specifier: '@k/one', target: 'packages/one/src/index.ts', wildcard: false },
      { specifier: '@k/one/*', target: 'packages/one/src/*', wildcard: true },
    ]);
  });

  it('is empty rather than wrong when there are no paths at all', () => {
    expect(pathEntriesOf({ compilerOptions: {} })).toEqual([]);
    expect(pathEntriesOf({})).toEqual([]);
  });

  it('refuses an entry with fallbacks instead of picking one', () => {
    // Two targets means the question this check asks - "do the two sides name the same file?" -
    // has no single answer, and quietly taking the first would invent one.
    expect(() =>
      pathEntriesOf({ compilerOptions: { paths: { '@k/one': ['a.ts', 'b.ts'] } } }),
    ).toThrow(/exactly one target/);
  });
});

describe('finding the specifiers a file imports', () => {
  // Every fixture below is assembled from parts rather than written out, and so is this comment's
  // way of not naming one. The last test in this file scans this directory, so a specifier spelled
  // whole in an import position here - in a fixture or in prose - would be read as this repository
  // importing a package that does not exist, and the check would fail over its own example.
  const scope = `@${'kynviora'}/`;

  it('finds a bare one and a subpath one', () => {
    expect(
      workspaceSpecifiersIn(
        `import { a } from '${scope}domain';\nimport { b } from "${scope}db/pool";\n`,
      ),
    ).toEqual([`${scope}db/pool`, `${scope}domain`]);
  });

  it('finds one imported for its side effects, and one imported dynamically', () => {
    expect(
      workspaceSpecifiersIn(`import '${scope}safety';\nawait import('${scope}fixtures');\n`),
    ).toEqual([`${scope}fixtures`, `${scope}safety`]);
  });

  it('leaves other packages alone', () => {
    expect(
      workspaceSpecifiersIn(`import { z } from 'zod';\nimport x from './local.js';\n`),
    ).toEqual([]);
  });

  it('ignores a package named somewhere that is not an import', () => {
    // A name in a message or an assertion is not a specifier a resolver has to answer, and
    // demanding that it resolve would make prose fail the build.
    expect(workspaceSpecifiersIn(`throw new Error('${scope}domain is not installed');\n`)).toEqual(
      [],
    );
  });

  it('reports each one once however often it appears', () => {
    expect(workspaceSpecifiersIn(`from '${scope}domain'\nfrom '${scope}domain'\n`)).toEqual([
      `${scope}domain`,
    ]);
  });

  it('separates a package from a reach past its entry point', () => {
    expect(packageOf('@kynviora/domain')).toBe('@kynviora/domain');
    expect(packageOf('@kynviora/domain/schedule')).toBe('@kynviora/domain');
    expect(isSubpath('@kynviora/domain')).toBe(false);
    expect(isSubpath('@kynviora/domain/schedule')).toBe(true);
  });
});

describe('what a manifest promises', () => {
  const packageDir = 'packages/domain';

  it('takes `exports` over `main`, because a resolver that reads both stops at the first', () => {
    const manifest: Manifest = {
      main: './src/legacy.ts',
      exports: { '.': './src/index.ts' },
    };
    expect(manifestEntryPoint(manifest, packageDir)).toBe('packages/domain/src/index.ts');
  });

  it('reads a bare string `exports`', () => {
    expect(manifestEntryPoint({ exports: './src/index.ts' }, packageDir)).toBe(
      'packages/domain/src/index.ts',
    );
  });

  it('falls back to `main` when there is no `exports`', () => {
    expect(manifestEntryPoint({ main: './src/index.ts' }, packageDir)).toBe(
      'packages/domain/src/index.ts',
    );
  });

  it('answers null rather than a guess when a manifest declares nothing', () => {
    expect(manifestEntryPoint({}, packageDir)).toBeNull();
  });

  it('expands the one wildcard form these manifests use', () => {
    expect(
      manifestSubpathTarget({ exports: { './*': './src/*.ts' } }, packageDir, 'schedule'),
    ).toBe('packages/domain/src/schedule.ts');
  });

  it('answers null for a subpath no `exports` map covers', () => {
    // Null is read by the test below as "this side cannot answer", never as agreement.
    expect(manifestSubpathTarget({ main: './src/index.ts' }, packageDir, 'schedule')).toBeNull();
  });
});

describe('spotting tsconfig path resolution in a configuration', () => {
  it('finds it at the top level', () => {
    expect(enablesTsconfigPaths({ resolve: { tsconfigPaths: true } })).toBe(true);
  });

  it('finds it inside a project, which is where it was', () => {
    expect(
      enablesTsconfigPaths({ test: { projects: [{ resolve: { tsconfigPaths: true } }] } }),
    ).toBe(true);
  });

  it('is not fooled by the option being present and off', () => {
    expect(enablesTsconfigPaths({ resolve: { tsconfigPaths: false } })).toBe(false);
    expect(enablesTsconfigPaths({ resolve: {} })).toBe(false);
  });

  it('survives a configuration that refers to itself', () => {
    const config: Record<string, unknown> = { resolve: {} };
    config['self'] = config;
    expect(enablesTsconfigPaths(config)).toBe(false);
  });
});

describe('the repository as it actually is', () => {
  const baseTsconfig = readJson(REPO_ROOT, 'tsconfig.base.json');
  const entries = pathEntriesOf(baseTsconfig);
  const bare = entries.filter((entry) => !entry.wildcard);

  const manifestFor = (specifier: string): { manifest: Manifest; dir: string } | null => {
    const entry = bare.find((candidate) => candidate.specifier === specifier);
    if (entry === undefined) return null;
    const dir = entry.target.slice(0, entry.target.indexOf('/src/'));
    const manifestPath = join(REPO_ROOT, dir, 'package.json');
    if (!existsSync(manifestPath)) return null;
    return { manifest: readJson(REPO_ROOT, `${dir}/package.json`) as Manifest, dir };
  };

  it('declares paths at all, so the comparisons below are not trivially true', () => {
    // DEC-102: an empty list would make every assertion under it pass without looking at anything.
    expect(entries.length).toBeGreaterThan(10);
    expect(bare.length).toBeGreaterThan(5);
  });

  it('does not put the resolver back into tsconfig auto-discovery', () => {
    expect(
      enablesTsconfigPaths(vitestConfig),
      'resolve.tsconfigPaths makes Rolldown walk for a tsconfig per specifier, keyed on the ' +
        'importing file, on its own thread pool - which is what made `npm run verify` fail a ' +
        'transform at random on about one run in two (DEV-096). Nothing here needs it: every ' +
        '@kynviora/* package is a workspace whose manifest names the same entry point.',
    ).toBe(false);
  });

  it('names a real file in every paths entry that is not a wildcard', () => {
    for (const entry of bare) {
      expect(existsSync(join(REPO_ROOT, entry.target)), entry.specifier).toBe(true);
    }
  });

  it('has a workspace manifest for each one that promises the same file', () => {
    for (const entry of bare) {
      const found = manifestFor(entry.specifier);
      expect(found, `${entry.specifier} has no package.json beside its src/`).not.toBeNull();
      const { manifest, dir } = found as { manifest: Manifest; dir: string };
      expect(manifest.name, `${dir} is not named after the specifier`).toBe(entry.specifier);
      expect(manifestEntryPoint(manifest, dir), entry.specifier).toBe(entry.target);
    }
  });

  it('is symlinked under node_modules, which is what makes the manifest reachable', () => {
    for (const entry of bare) {
      const linked = join(REPO_ROOT, 'node_modules', entry.specifier, 'package.json');
      expect(existsSync(linked), `${entry.specifier} is not installed as a workspace`).toBe(true);
    }
  });

  it('imports nothing the workspace cannot answer the same way the paths entry does', () => {
    const files = sourceFilesUnder(REPO_ROOT, ['packages', 'services', 'db', 'scripts', 'apps']);
    expect(files.length, 'no source files were scanned').toBeGreaterThan(200);

    const unanswerable: string[] = [];
    const disagreeing: string[] = [];
    for (const specifier of new Set(files.flatMap((file) => file.specifiers))) {
      const found = manifestFor(packageOf(specifier));
      if (found === null) {
        unanswerable.push(`${specifier}: no manifest`);
        continue;
      }
      const { manifest, dir } = found;
      const viaManifest = isSubpath(specifier)
        ? manifestSubpathTarget(manifest, dir, specifier.slice(packageOf(specifier).length + 1))
        : manifestEntryPoint(manifest, dir);
      if (viaManifest === null) {
        unanswerable.push(`${specifier}: the manifest does not cover it`);
        continue;
      }
      const entry = entries.find(
        (candidate) =>
          candidate.specifier === specifier ||
          (candidate.wildcard && specifier.startsWith(candidate.specifier.slice(0, -1))),
      );
      const viaPaths =
        entry === undefined
          ? null
          : entry.wildcard
            ? entry.target.replace('*', specifier.slice(entry.specifier.length - 1))
            : entry.target;
      if (viaPaths === null) {
        unanswerable.push(`${specifier}: no paths entry`);
        continue;
      }
      // A wildcard `paths` target carries no extension; the manifest's does. Compare what a
      // resolver would land on, which is the file.
      const same = viaManifest === viaPaths || viaManifest === `${viaPaths}.ts`;
      if (!same) disagreeing.push(`${specifier}: paths -> ${viaPaths}, manifest -> ${viaManifest}`);
    }

    expect(unanswerable, 'a specifier the workspace cannot resolve without tsconfig paths').toEqual(
      [],
    );
    expect(disagreeing, 'typecheck and the suite would load different files').toEqual([]);
  });

  it('scans the trees the suite actually runs, including the app', () => {
    // The mobile project has never had tsconfigPaths and imports four of these packages, so it is
    // the half of the repository that was already proving the workspace answer works.
    const files = sourceFilesUnder(REPO_ROOT, ['apps']);
    expect(files.some((file) => file.specifiers.includes(`${WORKSPACE_SCOPE}presentation`))).toBe(
      true,
    );
  });
});
