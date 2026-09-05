import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RETENTION_INTERVAL_MS,
  DEFAULT_RETENTION_LEASE_MS,
  DEFAULT_RETENTION_RETRY_MS,
  MAX_RETENTION_INTERVAL_MS,
  assertRetentionAccountedFor,
  readRetentionDeployment,
  readRetentionWorkerConfig,
} from './config.js';

/**
 * What a deployment has to say about retention before it may start.
 *
 * Spec references: `16` (retention deadlines), `21` (environments), `14` (deny by default),
 * DEC-121, `DEV-063`.
 *
 * THE ONE THAT MATTERS MOST IS THE ABSENCE TEST
 * A production process that was never told anything about retention must not start. That is the
 * whole of the fail-closed rule, and it is easy to write a version of this module that passes
 * every other test here and quietly defaults to "somebody else does it".
 */

describe('the retention schedule', () => {
  it('has defaults that need no configuration', () => {
    expect(readRetentionWorkerConfig({})).toEqual({
      intervalMs: DEFAULT_RETENTION_INTERVAL_MS,
      retryIntervalMs: DEFAULT_RETENTION_RETRY_MS,
      leaseMs: DEFAULT_RETENTION_LEASE_MS,
    });
  });

  it('reads an interval, a retry and a lease', () => {
    expect(
      readRetentionWorkerConfig({
        KYNVIORA_RETENTION_INTERVAL_MS: '60000',
        KYNVIORA_RETENTION_RETRY_MS: '30000',
        KYNVIORA_RETENTION_LEASE_MS: '120000',
      }),
    ).toEqual({ intervalMs: 60_000, retryIntervalMs: 30_000, leaseMs: 120_000 });
  });

  it('refuses an interval longer than the shortest deadline in the matrix', () => {
    // The interval is the overshoot past every deadline (`DEV-063`), and the shortest deadline in
    // `docs/RETENTION.md` is the Visit Pack's 24 hours. An interval above it could more than
    // double the life of the content it governs.
    expect(() =>
      readRetentionWorkerConfig({
        KYNVIORA_RETENTION_INTERVAL_MS: String(MAX_RETENTION_INTERVAL_MS + 1),
      }),
    ).toThrow(/at most/);

    expect(
      readRetentionWorkerConfig({
        KYNVIORA_RETENTION_INTERVAL_MS: String(MAX_RETENTION_INTERVAL_MS),
      }).intervalMs,
    ).toBe(MAX_RETENTION_INTERVAL_MS);
  });

  it('refuses a retry slower than the interval, which would be backwards', () => {
    expect(() =>
      readRetentionWorkerConfig({
        KYNVIORA_RETENTION_INTERVAL_MS: '60000',
        KYNVIORA_RETENTION_RETRY_MS: '60001',
      }),
    ).toThrow(/must not exceed/);
  });

  it('refuses a sub-second schedule, which would spin rather than sweep', () => {
    expect(() => readRetentionWorkerConfig({ KYNVIORA_RETENTION_INTERVAL_MS: '999' })).toThrow(
      /at least 1000/,
    );
  });

  it.each(['nonsense', '1.5', '-1000', '0'])('refuses %s as an interval', (raw) => {
    expect(() => readRetentionWorkerConfig({ KYNVIORA_RETENTION_INTERVAL_MS: raw })).toThrow();
  });

  it('treats an empty string as unset rather than as zero', () => {
    expect(readRetentionWorkerConfig({ KYNVIORA_RETENTION_INTERVAL_MS: '  ' }).intervalMs).toBe(
      DEFAULT_RETENTION_INTERVAL_MS,
    );
  });
});

describe('what a deployment says about retention', () => {
  it('defaults to none, so that the production check has something to catch', () => {
    expect(readRetentionDeployment({})).toEqual({ mode: 'none', acknowledgedUnswept: false });
  });

  it.each(['worker', 'external', 'none'] as const)('accepts %s', (mode) => {
    expect(readRetentionDeployment({ KYNVIORA_RETENTION: mode }).mode).toBe(mode);
  });

  it('refuses a mode it does not recognise rather than falling back', () => {
    expect(() => readRetentionDeployment({ KYNVIORA_RETENTION: 'yes' })).toThrow(
      /worker, external, none/,
    );
  });

  it('reads the unswept acknowledgement only from an exact 1', () => {
    expect(readRetentionDeployment({ KYNVIORA_ALLOW_UNSWEPT_START: '1' }).acknowledgedUnswept).toBe(
      true,
    );
    expect(
      readRetentionDeployment({ KYNVIORA_ALLOW_UNSWEPT_START: 'true' }).acknowledgedUnswept,
    ).toBe(false);
  });
});

describe('starting without retention', () => {
  it('is refused in production when nothing has been said about it', () => {
    expect(() =>
      assertRetentionAccountedFor({ mode: 'none', acknowledgedUnswept: false }, true),
    ).toThrow(/No retention is configured/);
  });

  it('names all three ways out, so the refusal is actionable', () => {
    let message = '';
    try {
      assertRetentionAccountedFor({ mode: 'none', acknowledgedUnswept: false }, true);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('KYNVIORA_RETENTION=worker');
    expect(message).toContain('KYNVIORA_RETENTION=external');
    expect(message).toContain('KYNVIORA_ALLOW_UNSWEPT_START=1');
  });

  it('is allowed outside production, where nothing was promised to anybody', () => {
    expect(() =>
      assertRetentionAccountedFor({ mode: 'none', acknowledgedUnswept: false }, false),
    ).not.toThrow();
  });

  it.each(['worker', 'external'] as const)('is not the case when the mode is %s', (mode) => {
    expect(() =>
      assertRetentionAccountedFor({ mode, acknowledgedUnswept: false }, true),
    ).not.toThrow();
  });

  it('is allowed in production once acknowledged on purpose', () => {
    expect(() =>
      assertRetentionAccountedFor({ mode: 'none', acknowledgedUnswept: true }, true),
    ).not.toThrow();
  });
});
