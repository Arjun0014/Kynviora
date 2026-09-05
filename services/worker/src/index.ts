/**
 * `@kynviora/worker` - the recurring half of retention.
 *
 * The sweep itself lives in `@kynviora/db` (`retention.ts`), because it is a property of the
 * schema and its policies rather than of any process. What is here is everything that turns one
 * sweep into a deadline that is actually kept: a schedule read from run history, a lease so two
 * workers do not race, per-category isolation so one failure is not silently the whole run's, and
 * the configuration rules that stop a production deployment starting with no retention at all.
 *
 * `main.ts` is deliberately not re-exported. It reads `process.env` and can start a process, and
 * a module that does either of those on import has no business being pulled in by a library
 * import somewhere else.
 */

export * from './config.js';
export * from './loop.js';
export * from './retentionRun.js';
export * from './schedule.js';
