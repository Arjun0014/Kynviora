/**
 * How often retention runs, and what a deployment has to say about it before it may start.
 *
 * Spec references: `16` (retention deadlines), `21` (environments), `14` (deny by default),
 * DEC-121, `DEV-063`, `docs/RETENTION.md`.
 *
 * THE INTERVAL IS THE OVERSHOOT, AND THAT IS NOT A FIGURE OF SPEECH
 * Every eligibility floor in `0023` sits exactly on its deadline: `purge_floor()` is `now() - 30
 * days`, Visit Pack content becomes purgeable at `expires_at + 24 hours`, and so on. A row is
 * therefore purged somewhere in `[deadline, deadline + interval]`, and no finite interval makes
 * the upper end of that equal to the deadline. Sweeping is discrete; the promise is not.
 *
 * So the interval is not a performance knob. It is the size of the gap between what
 * `docs/RETENTION.md` promises and what the system does, it is recorded as `DEV-063` rather than
 * hidden in a default, and it is bounded here: the shortest deadline in the matrix is 24 hours,
 * and an interval longer than that could more than double the life of the thing it governs.
 *
 * WHAT "FAIL CLOSED" MEANS FOR A JOB NOBODY WATCHES
 * A missing authenticator is loud - every request fails. A missing sweep is silent, and stays
 * silent for exactly as long as it takes somebody to ask why a table has grown. So a production
 * deployment must **say** which of three things is true about retention, and a process that has
 * not been told refuses to start rather than serving a privacy promise nothing keeps.
 */

/** One hour. Small enough that `DEV-063`'s overshoot is not something an operator has to think about. */
export const DEFAULT_RETENTION_INTERVAL_MS = 3_600_000;

/** Five minutes. How soon a sweep that did not fully succeed is tried again. */
export const DEFAULT_RETENTION_RETRY_MS = 300_000;

/**
 * Fifteen minutes. How long a worker's claim survives the worker.
 *
 * It is the recovery time after a process is killed mid-sweep, and it is also the age at which an
 * unfinished run is recorded as `ABANDONED` - one number, because they are one question: past
 * this, the run is no longer covered by anything.
 */
export const DEFAULT_RETENTION_LEASE_MS = 900_000;

/** The shortest deadline in `docs/RETENTION.md` is 24 hours, and the interval is the overshoot. */
export const MAX_RETENTION_INTERVAL_MS = 86_400_000;

/** A sweep is not a sub-second operation, and a schedule that thinks it is spins. */
export const MIN_RETENTION_MS = 1_000;

export interface RetentionWorkerConfig {
  readonly intervalMs: number;
  readonly retryIntervalMs: number;
  readonly leaseMs: number;
}

export const DEFAULT_RETENTION_WORKER_CONFIG: RetentionWorkerConfig = Object.freeze({
  intervalMs: DEFAULT_RETENTION_INTERVAL_MS,
  retryIntervalMs: DEFAULT_RETENTION_RETRY_MS,
  leaseMs: DEFAULT_RETENTION_LEASE_MS,
});

/** What a deployment has said about retention. */
export type RetentionMode =
  /** This process runs the sweep on a timer. */
  | 'worker'
  /** Something else runs it - a second deployment of this same worker. This process does not. */
  | 'external'
  /** Nothing runs it. Legal outside production; in production it needs an acknowledgement. */
  | 'none';

export const RETENTION_MODES: readonly RetentionMode[] = ['worker', 'external', 'none'];

export interface RetentionDeployment {
  readonly mode: RetentionMode;
  /** `KYNVIORA_ALLOW_UNSWEPT_START=1`: a deliberate, named decision to run without retention. */
  readonly acknowledgedUnswept: boolean;
}

type Env = Readonly<Partial<Record<string, string>>>;

function readDuration(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_RETENTION_MS) {
    throw new Error(
      `${name} must be an integer number of milliseconds of at least ${String(MIN_RETENTION_MS)}; ` +
        `got ${JSON.stringify(raw)}.`,
    );
  }
  return value;
}

/**
 * Read the schedule, refusing anything that would quietly break a deadline.
 *
 * Every refusal below is a deadline being protected rather than a preference being enforced,
 * which is why none of them is a warning.
 */
export function readRetentionWorkerConfig(env: Env = process.env): RetentionWorkerConfig {
  const intervalMs = readDuration(
    env,
    'KYNVIORA_RETENTION_INTERVAL_MS',
    DEFAULT_RETENTION_INTERVAL_MS,
  );
  const retryIntervalMs = readDuration(
    env,
    'KYNVIORA_RETENTION_RETRY_MS',
    DEFAULT_RETENTION_RETRY_MS,
  );
  const leaseMs = readDuration(env, 'KYNVIORA_RETENTION_LEASE_MS', DEFAULT_RETENTION_LEASE_MS);

  if (intervalMs > MAX_RETENTION_INTERVAL_MS) {
    throw new Error(
      `KYNVIORA_RETENTION_INTERVAL_MS must be at most ${String(MAX_RETENTION_INTERVAL_MS)} ` +
        '(24 hours). The sweep interval is the maximum overshoot past every deadline in ' +
        'docs/RETENTION.md, and the shortest of those is 24 hours (DEV-063).',
    );
  }
  if (retryIntervalMs > intervalMs) {
    throw new Error(
      'KYNVIORA_RETENTION_RETRY_MS must not exceed KYNVIORA_RETENTION_INTERVAL_MS. A sweep that ' +
        'partly failed would then be retried later than a sweep that succeeded, which is ' +
        'backwards.',
    );
  }

  return { intervalMs, retryIntervalMs, leaseMs };
}

/** Read what the deployment has said about retention. Absent means "nothing runs it". */
export function readRetentionDeployment(env: Env = process.env): RetentionDeployment {
  const raw = env.KYNVIORA_RETENTION?.trim();
  const mode = raw === undefined || raw === '' ? 'none' : raw;

  if (!RETENTION_MODES.includes(mode as RetentionMode)) {
    throw new Error(
      `KYNVIORA_RETENTION must be one of ${RETENTION_MODES.join(', ')}; got ${JSON.stringify(raw)}.`,
    );
  }

  return {
    mode: mode as RetentionMode,
    acknowledgedUnswept: env.KYNVIORA_ALLOW_UNSWEPT_START === '1',
  };
}

/**
 * Refuse to start a production process that has not accounted for retention.
 *
 * `none` is the default precisely so that this check has something to catch: a deployment that
 * never thought about retention and one that decided against it are indistinguishable from the
 * environment, and only one of them should be able to start. Outside production the check does
 * not apply, because a development database purging nothing is not a promise anybody made.
 *
 * The acknowledgement exists because there are legitimate reasons to run without a sweep - a
 * read-only replica, a staging copy, a migration window - and none of them should require
 * pretending the sweep is happening somewhere.
 */
export function assertRetentionAccountedFor(
  deployment: RetentionDeployment,
  isProduction: boolean,
): void {
  if (!isProduction) return;
  if (deployment.mode !== 'none') return;
  if (deployment.acknowledgedUnswept) return;

  throw new Error(
    'No retention is configured. docs/RETENTION.md promises that deleted personal data is ' +
      'physically removed within 30 days, and nothing in this deployment would do it. Set ' +
      'KYNVIORA_RETENTION=worker to sweep from this process, KYNVIORA_RETENTION=external if a ' +
      'separate worker deployment does it, or KYNVIORA_ALLOW_UNSWEPT_START=1 to start without ' +
      'retention on purpose (spec 16, DEC-121).',
  );
}
