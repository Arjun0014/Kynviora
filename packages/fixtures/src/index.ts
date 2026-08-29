/**
 * `@kynviora/fixtures` - synthetic test data.
 *
 * SPEC 21 / OPERATING BRIEF: no real patient or family health information appears anywhere in
 * this package. Every profile, product and package observation is invented.
 *
 * Regulatory fixtures carry `NEEDS_PRIMARY_VERIFICATION` and are rejected by the Citation Gate
 * (DEC-016). See the honesty notice at the top of `regulatory.ts`.
 */

export * from './regulatory.js';
export * from './catalog.js';
