/**
 * `@kynviora/catalog` - Living Catalog engine.
 *
 * Deterministic, side-effect-free logic for turning package evidence into versioned catalog
 * records: barcode validation, ingredient normalization, formulation fingerprinting, conflict
 * detection and corroboration policy.
 *
 * Nothing in this package performs I/O or reaches a model. It never produces a safety
 * conclusion - `08` keeps catalog evidence and safety knowledge strictly separate.
 */

export * from './gtin.js';
export * from './ingredients.js';
export * from './fingerprint.js';
export * from './conflict.js';
export * from './corroboration.js';
export * from './capture.js';
export * from './trustPassport.js';
