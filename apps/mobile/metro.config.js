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

module.exports = config;
