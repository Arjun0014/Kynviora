/**
 * `@kynviora/staff-web` - the reviewer console process.
 *
 * The console's behaviour lives in `@kynviora/staff-console`; this package is the process that
 * serves it and the session store behind it. Nothing here holds a database connection.
 */

export * from './sessionStore.js';
export * from './server.js';
