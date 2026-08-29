/**
 * Domain ports: the only way effects enter otherwise-pure domain logic (DEC-002, DEC-003).
 *
 * `09_SAFETY_WATCH_AND_EVIDENCE_MODEL.md` requires that "Replaying the same versions must
 * reproduce the result." Ambient time and ambient randomness are the two things that quietly
 * break that guarantee, so both are injected. A lint rule (`no-restricted-syntax`) makes a bare
 * `new Date()` an error in production code.
 */

import type { OperationId } from './ids.js';

/**
 * An instant in time, always UTC, always explicit.
 *
 * Stored as an ISO-8601 string rather than a `Date` because assessment inputs are persisted and
 * replayed, and a serialized instant compares and hashes deterministically across processes.
 */
export type Instant = string & { readonly __instant: unique symbol };

export function toInstant(date: Date): Instant {
  return date.toISOString() as Instant;
}

export function instantFrom(iso: string): Instant {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`Invalid instant: ${iso}`);
  }
  return parsed.toISOString() as Instant;
}

export function instantToDate(instant: Instant): Date {
  return new Date(instant);
}

/** Chronological comparison. Negative if `a` is earlier. */
export function compareInstants(a: Instant, b: Instant): number {
  return Date.parse(a) - Date.parse(b);
}

/**
 * Calendar date without a time component, `YYYY-MM-DD`.
 *
 * Distinct from {@link Instant} because regulatory effective dates, expiry dates and
 * publication dates are genuinely date-only. Coercing them to an instant invents a timezone and
 * can shift an effective date across a day boundary - which `19` requires to be tested and `06`
 * requires the Lens to display accurately.
 */
export type CalendarDate = string & { readonly __calendarDate: unique symbol };

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function calendarDate(value: string): CalendarDate {
  if (!CALENDAR_DATE_PATTERN.test(value)) {
    throw new TypeError(`Invalid calendar date (expected YYYY-MM-DD): ${value}`);
  }
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  // Reject impossible dates such as 2026-02-30 that match the pattern but are not real.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new TypeError(`Invalid calendar date (not a real date): ${value}`);
  }
  return value as CalendarDate;
}

export function isCalendarDate(value: unknown): value is CalendarDate {
  if (typeof value !== 'string') return false;
  try {
    calendarDate(value);
    return true;
  } catch {
    return false;
  }
}

export function compareCalendarDates(a: CalendarDate, b: CalendarDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The calendar date portion of an instant, in UTC. */
export function instantToCalendarDate(instant: Instant): CalendarDate {
  return instant.slice(0, 10) as CalendarDate;
}

/**
 * Source of "now".
 *
 * Every domain function that needs the current time receives one of these. Tests inject a fixed
 * clock so a replayed assessment produces byte-identical output.
 */
export interface Clock {
  now(): Instant;
}

/** Production clock. */
export function systemClock(): Clock {
  // eslint-disable-next-line no-restricted-syntax -- the single sanctioned source of ambient time
  return { now: () => new Date().toISOString() as Instant };
}

/** Test clock pinned to a fixed instant, optionally advanceable. */
export function fixedClock(start: Instant): Clock & { advanceMs(ms: number): void } {
  let current = Date.parse(start);
  return {
    now: () => new Date(current).toISOString() as Instant,
    advanceMs(ms: number) {
      current += ms;
    },
  };
}

/**
 * Source of non-guessable identifiers (`07`).
 *
 * Injected rather than called ambiently so that replay and fixture tests can produce stable
 * IDs, which in turn lets assessment output be compared exactly.
 */
export interface IdGenerator {
  next(): string;
}

/** Production generator - cryptographically random UUID v4. */
export function cryptoIdGenerator(): IdGenerator {
  return { next: () => globalThis.crypto.randomUUID() };
}

/**
 * Deterministic generator for tests and fixtures.
 *
 * Produces UUID-shaped values so anything validating an ID's format still passes, while
 * remaining perfectly reproducible.
 */
export function sequentialIdGenerator(prefix = '00000000'): IdGenerator {
  let n = 0;
  return {
    next() {
      n += 1;
      const hex = n.toString(16).padStart(12, '0');
      return `${prefix}-0000-4000-8000-${hex}`;
    },
  };
}

/**
 * Structured, non-sensitive logging port.
 *
 * `14_SECURITY.md` forbids diagnoses, profile-linked medicine names, document names, full alert
 * explanations, tokens, raw profile identifiers and label images from ever reaching logs. The
 * port therefore accepts only a machine code plus a bag of *pre-approved* scalar fields; there
 * is no `message: string` parameter into which a caller could interpolate a medicine name.
 */
export interface Logger {
  debug(code: string, fields?: LogFields): void;
  info(code: string, fields?: LogFields): void;
  warn(code: string, fields?: LogFields): void;
  error(code: string, fields?: LogFields): void;
}

/**
 * Values permitted in a log record.
 *
 * Intentionally excludes arbitrary objects and free strings that could carry health content.
 * Correlation IDs, durations, counts, enum codes and booleans only.
 */
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

export function noopLogger(): Logger {
  const noop = (): void => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop };
}

/**
 * Ambient context carried through a unit of work.
 *
 * `20_OBSERVABILITY_INCIDENTS_AND_OPERATIONS.md` requires correlation IDs across
 * request/job/publication flows so an incident can be traced without reading health content.
 */
export interface WorkContext {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly correlationId: string;
  /** Set when the work originates from a retryable client mutation (`13`). */
  readonly operationId?: OperationId;
}
