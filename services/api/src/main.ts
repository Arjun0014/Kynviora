/**
 * The API process.
 *
 * Spec references: `13` (backend and sync), `14` (deny by default), `20` (structured logs with
 * correlation IDs, no health content), `21` (environments), `BLK-001`.
 *
 * `createServer` has existed since Stage 7 and every test drives it in memory. Nothing ever
 * listened on a port, which meant the whole system was verifiable and not runnable - you could
 * prove the authorization rules held and could not open the app. This is the missing half.
 *
 * WHAT IT REFUSES TO DO
 * It will not start with no authenticator configured **and** no explicit acknowledgement, because
 * a server where every request is anonymous looks broken in exactly the same way as a server whose
 * auth is misconfigured, and the two should not be confused. It will not enable header-based
 * development identity under `NODE_ENV=production`. And it does not read a database password,
 * because there is nothing to connect to yet: `BLK-001` is open and the store is a local
 * PostgreSQL that the process owns.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntimeDb, resolveDataDir, seedDevelopmentData, type RuntimeDb } from '@kynviora/db';
import {
  systemClock,
  type Clock,
  type Instant,
  type LogFields,
  type Logger,
} from '@kynviora/domain';
import { ALL_FIXTURE_SOURCES } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';
import { createServer } from './server.js';
import type { DatabasePool, Principal } from './context.js';
import { DevAuthRefused, createDevAuthenticator } from './devAuth.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface MainConfig {
  readonly port: number;
  readonly host: string;
  readonly dataDir: string | undefined;
  readonly devAuth: boolean;
  readonly seed: boolean;
  readonly allowAnonymousStart: boolean;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer; got ${JSON.stringify(raw)}.`);
  }
  return value;
}

export function readConfig(): MainConfig {
  return {
    port: readNumber('KYNVIORA_API_PORT', 3000),
    // Loopback by default. A development server that binds every interface is one that ends up
    // reachable from a network somebody did not think about.
    host: process.env.KYNVIORA_API_HOST ?? '127.0.0.1',
    // Resolved against the workspace root rather than the working directory. `npm run dev` runs
    // from `services/api` and `npm run migrate` runs from `db`, so a relative path produced two
    // separate databases - and because PGlite is a single writer, the second one is an empty
    // database that reads as data loss rather than as a second copy.
    dataDir: resolveDataDir(process.env.KYNVIORA_LOCAL_DB_DIR),
    devAuth: process.env.KYNVIORA_DEV_AUTH === '1',
    seed: process.env.KYNVIORA_DEV_SEED === '1',
    allowAnonymousStart: process.env.KYNVIORA_ALLOW_ANONYMOUS_START === '1',
  };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * A line-per-record logger.
 *
 * `20` requires correlation IDs and forbids the log from becoming a copy of health content, which
 * the {@link LogFields} type already enforces - this only has to not undo it. Nothing here
 * stringifies an arbitrary object.
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

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function poolFor(db: RuntimeDb): DatabasePool {
  return {
    withUser: (userId, fn) => db.withUser(userId, fn),
    withService: (fn) => db.withService(fn),
  };
}

/**
 * The one clock this process uses.
 *
 * `systemClock` is the single sanctioned source of ambient time in the codebase; the lint rule
 * banning `new Date()` exists so that every other module receives time instead of reading it, and
 * a composition root is not an excuse to open a second source.
 */
const clock: Clock = systemClock();
const now = (): Instant => clock.now();

/**
 * The registered regulatory sources.
 *
 * The shipped fixtures, unmodified - which means every one of them is rejected by the Citation
 * Gate, because the research behind them came from search summaries rather than retrieved official
 * documents (DEC-016). A running server therefore publishes no regulatory status, and that is
 * correct rather than a configuration mistake. `BLK-004` is what changes it.
 */
function loadSources(): Promise<ReadonlyMap<string, SourceRegistryEntry>> {
  return Promise.resolve(new Map(ALL_FIXTURE_SOURCES.map((source) => [source.id, source])));
}

export interface StartedServer {
  readonly url: string;
  stop(): Promise<void>;
}

export interface StartOverrides {
  /** Injected so a test can start a server without writing a log line per request. */
  readonly logger?: Logger;
}

export async function start(
  config: MainConfig = readConfig(),
  overrides: StartOverrides = {},
): Promise<StartedServer> {
  const logger = overrides.logger ?? consoleLogger(clock);

  // The flag is read from the config rather than from the environment a second time, so a test
  // can start a server without mutating `process.env` for every other test in the file.
  const authenticate = createDevAuthenticator({
    now,
    enabled: config.devAuth ? '1' : '',
  });

  if (authenticate === null && !config.allowAnonymousStart) {
    // A server that authenticates nobody serves nobody, and it fails in a way that looks like a
    // bug in every route rather than an absent configuration. Say which it is, once, here.
    throw new Error(
      'No authenticator is configured. Phase 1.1 has not chosen an auth provider, so there is no ' +
        'production authenticator yet. Set KYNVIORA_DEV_AUTH=1 for header-based development ' +
        'identity, or KYNVIORA_ALLOW_ANONYMOUS_START=1 to start a server that rejects every ' +
        'authenticated request on purpose.',
    );
  }

  const db = await createRuntimeDb(config.dataDir === undefined ? {} : { dataDir: config.dataDir });

  // Seeded here rather than by a separate command, on the connection this process already holds.
  // PGlite is a single writer: a standalone seed against the same directory as a running server
  // does not share its state, and the last process to exit overwrites the other. That failed
  // silently once, which is why it is no longer possible to do.
  if (config.seed) {
    const result = await db.withService((conn) => seedDevelopmentData(conn));
    logger.info(result.seeded ? 'dev.seed.applied' : 'dev.seed.present', {
      items: result.itemCount,
    });
    if (result.seeded && overrides.logger === undefined) {
      process.stdout.write(
        [
          '',
          'Development fixture (synthetic; no safety or regulatory content - BLK-004, BLK-006):',
          `  x-kynviora-dev-user: ${result.userId}`,
          `  profileId:           ${result.profileId}`,
          '',
        ].join(String.fromCharCode(10)),
      );
    }
  }

  const app = createServer({
    pool: poolFor(db),
    logger,
    authenticate: authenticate ?? ((): Promise<Principal | null> => Promise.resolve(null)),
    now,
    loadSources,
  });

  await app.listen({ port: config.port, host: config.host });

  // The port actually bound, not the one requested. `port: 0` asks the OS to pick one, which is
  // how a test starts several servers at once - and a URL built from the requested port then
  // points at port zero and fails to connect with an error that names neither.
  const address = app.server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : config.port;

  logger.info('api.started', {
    port: boundPort,
    dev_auth: config.devAuth,
    persisted: config.dataDir !== undefined,
  });

  return {
    url: `http://${config.host}:${String(boundPort)}`,
    stop: async () => {
      await app.close();
      await db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Whether this module was run directly rather than imported.
 *
 * Compared as resolved filesystem paths rather than by string suffix: `import.meta.url` is a
 * URL, so on Windows it arrives percent-encoded and with a drive letter, and a naive `endsWith`
 * against `process.argv[1]` silently reports false. The symptom is a process that starts, does
 * nothing and exits zero, which is a genuinely confusing way to fail.
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
    (server) => {
      const shutdown = (): void => {
        void server.stop().then(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      process.stdout.write(`Kynviora API listening on ${server.url}\n`);
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `${error instanceof DevAuthRefused ? 'Refused' : 'Failed'}: ${message}\n`,
      );
      process.exit(1);
    },
  );
}
