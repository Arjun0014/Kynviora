/**
 * The retention worker as its own process.
 *
 *   npm run worker
 *
 * Spec references: `16` (retention deadlines), `21` (environments), `20` (structured logs),
 * DEC-121, DEC-037, `BLK-001`.
 *
 * WHICH OF THE TWO WAYS TO RUN THIS IS THE ONE THAT WORKS TODAY
 * There are two, and in this build only one of them can touch the development database:
 *
 *  - **In-process with the API**, by setting `KYNVIORA_RETENTION=worker`. The loop runs on the
 *    connection the API already holds.
 *  - **This file**, as a second process against its own data directory, or against a managed
 *    Postgres when `BLK-001` clears.
 *
 * PGlite is a **single writer** (DEC-037). Two processes opened on one data directory do not
 * share state and the last to exit overwrites the other - which has already silently destroyed
 * data in this repository once, and is why `npm run dev` seeds in-process rather than from a
 * separate command. A worker started against a directory a running API also has open would purge
 * from a stale copy and then write that copy over everything the API had done.
 *
 * So this entry point **refuses** to open a local data directory without being told to. That is
 * not caution about an unlikely mistake; it is the exact mistake this repository has already
 * made, and the alternative to refusing is a comment nobody reads at three in the morning.
 *
 * WHAT IS NOT HERE, AND IS NOT PRETENDED TO BE
 * A cloud scheduler. There is no deployment, no cron, no queue and no orchestrator in this build,
 * so this is a long-running process that keeps its own schedule from the run history - which is
 * the shape that works with or without one. `docs/RETENTION.md` says how it is meant to be
 * deployed; it does not claim it has been.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntimeDb, resolveDataDir } from '@kynviora/db';
import {
  cryptoIdGenerator,
  systemClock,
  type Clock,
  type LogFields,
  type Logger,
} from '@kynviora/domain';
import { randomUUID } from 'node:crypto';
import { readRetentionWorkerConfig, type RetentionWorkerConfig } from './config.js';
import { startRetentionLoop, type RetentionLoop } from './loop.js';

export interface WorkerConfig {
  readonly retention: RetentionWorkerConfig;
  readonly dataDir: string | undefined;
  /** `KYNVIORA_WORKER_ALLOW_LOCAL_DB=1`. See the single-writer note above. */
  readonly allowLocalDb: boolean;
}

export function readWorkerConfig(): WorkerConfig {
  return {
    retention: readRetentionWorkerConfig(),
    dataDir: resolveDataDir(process.env.KYNVIORA_LOCAL_DB_DIR),
    allowLocalDb: process.env.KYNVIORA_WORKER_ALLOW_LOCAL_DB === '1',
  };
}

/**
 * A line-per-record logger.
 *
 * Deliberately a copy of the API's rather than an import of it: a worker that depended on the API
 * package to write a log line would be a worker that cannot be deployed without it. What both
 * have to obey is the {@link LogFields} type, which is shared and is where the rule actually
 * lives - there is no `message: string` for a medicine name to be interpolated into.
 */
export function consoleLogger(clockFor: Clock): Logger {
  const emit =
    (level: string) =>
    (code: string, fields?: LogFields): void => {
      const record = { level, code, ...(fields ?? {}), at: clockFor.now() };
      process.stdout.write(`${JSON.stringify(record)}\n`);
    };
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
  };
}

export interface StartedWorker {
  readonly holder: string;
  stop(): Promise<void>;
}

export interface WorkerOverrides {
  readonly logger?: Logger;
}

export async function start(
  config: WorkerConfig = readWorkerConfig(),
  overrides: WorkerOverrides = {},
): Promise<StartedWorker> {
  if (config.dataDir !== undefined && !config.allowLocalDb) {
    throw new Error(
      'Refusing to open the local PGlite data directory from a second process. PGlite is a ' +
        'single writer (DEC-037): if the API is running against this directory, both processes ' +
        'see stale copies and the last to exit overwrites the other. Run retention in-process ' +
        'with KYNVIORA_RETENTION=worker instead, or set KYNVIORA_WORKER_ALLOW_LOCAL_DB=1 if you ' +
        'are certain nothing else has this directory open.',
    );
  }

  const clock = systemClock();
  const logger = overrides.logger ?? consoleLogger(clock);
  const db = await createRuntimeDb(config.dataDir === undefined ? {} : { dataDir: config.dataDir });

  const loop = startRetentionLoop({
    db,
    config: config.retention,
    clock,
    logger,
    ids: cryptoIdGenerator(randomUUID),
  });

  return {
    holder: loop.holder,
    stop: async () => {
      await loop.stop();
      await db.close();
    },
  };
}

/**
 * Whether this module was run directly rather than imported.
 *
 * Resolved paths rather than a string suffix, for the reason `services/api/src/main.ts` gives:
 * `import.meta.url` arrives percent-encoded with a drive letter on Windows, and a naive
 * `endsWith` reports false - producing a process that starts, does nothing, and exits zero.
 */
const isEntryPoint = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return resolve(fileURLToPath(import.meta.url)) === resolve(entry);
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  start().then(
    (worker: StartedWorker) => {
      const shutdown = (): void => {
        void worker.stop().then(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      process.stdout.write(`Kynviora retention worker running (holder ${worker.holder}).\n`);
    },
    (error: unknown) => {
      process.stderr.write(`Failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}

export type { RetentionLoop };
