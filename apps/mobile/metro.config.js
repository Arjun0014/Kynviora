// Metro configuration for the Kynviora monorepo.
//
// The app consumes shared packages (`@kynviora/domain`, `@kynviora/presentation`) directly from
// source rather than from a build output, so a change to a safety vocabulary is picked up without
// a build step and cannot drift between the client and the server.

const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Watch the whole workspace so shared package edits trigger a reload.
config.watchFolders = [workspaceRoot];

// Resolve from the app first, then the workspace root hoist location.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Prevent Metro resolving two copies of React, which breaks hooks at runtime.
config.resolver.disableHierarchicalLookup = true;

// The workspace packages are TypeScript source with ESM-style relative imports - `export * from
// './tokens.js'` - which is what `verbatimModuleSyntax` requires and what every other consumer
// resolves without help. Metro does not: it looks for `tokens.js`, does not find it, and fails
// the bundle. The rewrite is scoped to files inside `packages/`, because a `.js` import anywhere
// else - in `node_modules`, most of all - really does mean a `.js` file, and rewriting those
// would resolve a published package's own entry point to something that is not there.
const packagesRoot = path.resolve(workspaceRoot, 'packages');
const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolveRequest ?? context.resolveRequest;
  const origin = context.originModulePath;

  if (
    moduleName.startsWith('.') &&
    moduleName.endsWith('.js') &&
    typeof origin === 'string' &&
    origin.startsWith(packagesRoot)
  ) {
    try {
      return resolve(context, moduleName.slice(0, -'.js'.length), platform);
    } catch {
      // Fall through to the real name. A package that genuinely ships a sibling `.js` still
      // resolves, and a genuine missing module still reports the name the author wrote.
    }
  }

  return resolve(context, moduleName, platform);
};

module.exports = config;
