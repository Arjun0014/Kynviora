/**
 * `@kynviora/safety` - deterministic safety rule engine and assessment model.
 *
 * Server-side only (DEC-010). The mobile client never evaluates a rule and cannot compute or
 * raise severity; it receives assessments as validated read projections.
 */

export * from './rules.js';
