/**
 * `@kynviora/safety` - deterministic safety rule engine and assessment model.
 *
 * Server-side only (DEC-010). The mobile client never evaluates a rule and cannot compute or
 * raise severity; it receives assessments as validated read projections.
 */

export * from './rules.js';
export * from './shadow.js';

// `schedule.ts` used to be here. It moved to `@kynviora/domain` when Phase 4.2 arrived: a local
// reminder engine has to expand its own schedule on the device - `04` Phase 4.2 requires
// reminders "without relying on server timing", and a phone that is offline for a week still has
// to fire them. What DEC-010 keeps off the phone is *rule evaluation*: deciding that a substance
// interacts with a condition, and how urgent that is. Turning "08:00 in Asia/Kolkata" into an
// instant is calendar arithmetic over data the person typed themselves, and it was only ever in
// this package because the first caller was.
