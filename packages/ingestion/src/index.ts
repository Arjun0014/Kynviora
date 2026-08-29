/**
 * `@kynviora/ingestion` - source retrieval, preservation, change detection and candidate
 * extraction.
 *
 * This package can produce candidates. It has no ability to publish: no function here writes a
 * regulatory record, and the worker running an adapter holds only the grants in migration 0005
 * (spec 13, threat A13).
 */

export * from './adapter.js';
export * from './fixtureAdapter.js';
