/**
 * `@kynviora/regulatory` - Global Regulatory Registry and Lens.
 *
 * Holds what regulators say, kept strictly separate from what Kynviora concludes about a person
 * (`@kynviora/safety`). Nothing here performs I/O or reaches a model.
 */

export * from './records.js';
export * from './citationGate.js';
export * from './lens.js';
