/**
 * `@kynviora/staff-console` - the reviewer console's session, client, view models and pages.
 *
 * Deliberately depends on `@kynviora/domain` and nothing else. It does **not** depend on
 * `@kynviora/contracts` or `@kynviora/presentation`: those are the household client and the
 * household's copy rules, they are carried in the Expo bundle, and `13` asks for environment
 * isolation between a user surface and a staff one. Two packages is what that looks like here.
 *
 * The process that serves these pages is `apps/staff`. Everything decidable is decided in this
 * package, so the process is routing and the console's behaviour is tested without a server.
 */

export * from './session.js';
export * from './client.js';
export * from './views.js';
export * from './html.js';
export * from './pages.js';
