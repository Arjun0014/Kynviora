/**
 * `@kynviora/api` - the authenticated API boundary (spec 13).
 *
 * Route handlers hold no authorization logic of their own: they run against a connection bound
 * to the `kynviora_app` role with the caller's identity in the request GUC, so row-level security
 * applies to every query they can make.
 */

export * from './context.js';
export * from './errors.js';
export * from './server.js';
