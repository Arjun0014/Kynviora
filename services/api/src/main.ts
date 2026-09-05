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
import {
  openRuntimeDb,
  readManagedDatabaseUrl,
  resolveDataDir,
  seedDevelopmentData,
  type RuntimeDb,
} from '@kynviora/db';
import {
  cryptoIdGenerator,
  systemClock,
  type Clock,
  type Instant,
  type LogFields,
  type Logger,
} from '@kynviora/domain';
import { ALL_FIXTURE_SOURCES } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  assertRetentionAccountedFor,
  readRetentionDeployment,
  readRetentionWorkerConfig,
  startRetentionLoop,
  type RetentionDeployment,
  type RetentionLoop,
} from '@kynviora/worker';
import { randomUUID } from 'node:crypto';
import { createServer } from './server.js';
import type { DatabasePool, Principal } from './context.js';
import { DevAuthRefused, createDevAuthenticator } from './devAuth.js';
import { createSupabaseAuthenticator, httpJwks } from './supabaseAuth.js';
import { supabaseAuthProvider } from './accountLifecycle.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface MainConfig {
  readonly port: number;
  /**
   * Port for the staff surface, or `null` to serve no staff routes at all.
   *
   * Deny by default. `13` keeps internal APIs off the user API, and a staff origin that appears
   * because a default said so is one nobody decided to expose. Set `KYNVIORA_STAFF_PORT` to open
   * it; the reviewer console needs it and nothing else does.
   */
  readonly staffPort: number | null;
  readonly host: string;
  readonly dataDir: string | undefined;
  /**
   * The managed database this process attaches to, or `null` for the local PGlite directory.
   *
   * A connection string, so it is the one configuration value here that **is** a secret. It is
   * never logged; `openRuntimeDb` reports the host and database instead.
   */
  readonly databaseUrl: string | null;
  readonly devAuth: boolean;
  readonly seed: boolean;
  readonly allowAnonymousStart: boolean;
  /**
   * The Supabase project this deployment accepts tokens from, or `null`.
   *
   * Two values and neither is a secret: an issuer URL and an audience. That is the whole of what
   * a verifier needs when signatures are asymmetric, and it is why `14`'s rule about secrets in
   * configuration does not bite here - there is nothing to leak.
   */
  readonly supabase: {
    readonly issuer: string;
    readonly audience: string;
    /** Publishable key. Not a secret; the account routes need it to read the provider. */
    readonly anonKey: string | null;
    /**
     * Service-role key, where a deployment has one.
     *
     * The only secret in this configuration, and the whole of what stands between
     * `DEV-062` being built and being usable. Absent means account deletion refuses, rather
     * than performing the half it can (DEC-125).
     */
    readonly serviceKey: string | null;
    /** The `close-identity` Edge Function, where this deployment has one deployed. */
    readonly deletionFunctionUrl: string | null;
    /** The secret that function requires, where one is set on both sides. */
    readonly deletionSecret: string | null;
  } | null;
  /**
   * What this deployment has said about retention (DEC-121).
   *
   * `docs/RETENTION.md` promises that deleted personal data physically disappears within thirty
   * days. Nothing in an API process does that, so a production deployment has to name what does -
   * this process, a separate worker, or nothing on purpose. A missing answer is refused at
   * startup, for the same reason a missing authenticator is: the failure is otherwise silent, and
   * stays silent until somebody asks why a table has grown.
   */
  readonly retention: RetentionDeployment;
  /** Whether this is a production environment (`21`). Read once, here, rather than ambiently. */
  readonly production: boolean;
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

/** An optional positive-integer port. Absent means the surface is not served. */
function readOptionalPort(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return null;
  return readNumber(name, 0);
}

/** A trimmed environment value, or `null`. An empty string is not a configuration. */
function nonEmpty(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value === undefined || value === '' ? null : value;
}

/**
 * The Supabase configuration, or `null` where none is set.
 *
 * The issuer is the whole switch: setting it turns on token verification. The audience defaults
 * to `authenticated`, which is what Supabase issues for a signed-in user - a deployment that
 * needed a different one can say so, and one that does not should not have to.
 */
function readSupabase(): MainConfig['supabase'] {
  const issuer = process.env.KYNVIORA_SUPABASE_ISSUER?.trim();
  if (issuer === undefined || issuer === '') return null;

  // Refused loudly rather than coerced. A token is verified against this string exactly, and an
  // issuer with a trailing slash or a missing scheme fails every request in a way that looks
  // like a broken client.
  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    throw new Error(
      'KYNVIORA_SUPABASE_ISSUER must be an absolute URL, e.g. ' +
        'https://<project-ref>.supabase.co/auth/v1',
    );
  }
  if (
    parsed.protocol !== 'https:' &&
    parsed.hostname !== '127.0.0.1' &&
    parsed.hostname !== 'localhost'
  ) {
    // `14`: a token is a bearer credential and a key set fetched over plaintext can be replaced
    // in transit. Loopback is allowed so a local Supabase stack can be pointed at.
    throw new Error(
      'KYNVIORA_SUPABASE_ISSUER must be https, or loopback for a local Supabase stack.',
    );
  }

  return {
    // Trailing slash removed once, here. The issuer is compared to the `iss` claim exactly, and
    // the key set URL is built by appending - so a stray slash breaks both, in two different ways.
    issuer: issuer.replace(/\/$/, ''),
    audience: process.env.KYNVIORA_SUPABASE_AUDIENCE?.trim() ?? 'authenticated',
    anonKey: nonEmpty(process.env.KYNVIORA_SUPABASE_ANON_KEY),
    serviceKey: nonEmpty(process.env.KYNVIORA_SUPABASE_SERVICE_KEY),
    deletionFunctionUrl: nonEmpty(process.env.KYNVIORA_SUPABASE_DELETION_FUNCTION_URL),
    deletionSecret: nonEmpty(process.env.KYNVIORA_SUPABASE_DELETION_SECRET),
  };
}

export function readConfig(): MainConfig {
  return {
    port: readNumber('KYNVIORA_API_PORT', 3000),
    staffPort: readOptionalPort('KYNVIORA_STAFF_PORT'),
    // Loopback by default. A development server that binds every interface is one that ends up
    // reachable from a network somebody did not think about.
    host: process.env.KYNVIORA_API_HOST ?? '127.0.0.1',
    // Resolved against the workspace root rather than the working directory. `npm run dev` runs
    // from `services/api` and `npm run migrate` runs from `db`, so a relative path produced two
    // separate databases - and because PGlite is a single writer, the second one is an empty
    // database that reads as data loss rather than as a second copy.
    dataDir: resolveDataDir(process.env.KYNVIORA_LOCAL_DB_DIR),
    databaseUrl: readManagedDatabaseUrl(),
    devAuth: process.env.KYNVIORA_DEV_AUTH === '1',
    seed: process.env.KYNVIORA_DEV_SEED === '1',
    allowAnonymousStart: process.env.KYNVIORA_ALLOW_ANONYMOUS_START === '1',
    supabase: readSupabase(),
    retention: readRetentionDeployment(),
    production: process.env.NODE_ENV === 'production',
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

/**
 * Choose the authenticator.
 *
 * Two exist and they are mutually exclusive by construction, which is the point (DEC-118).
 *
 *  - **Supabase**, when `KYNVIORA_SUPABASE_ISSUER` is set. Verifies a signed token, takes identity
 *    from `sub`, and holds no secret: signatures are checked with a published public key.
 *  - **The development header**, when `KYNVIORA_DEV_AUTH=1`. Refused outright under
 *    `NODE_ENV=production` and unchanged since Stage 7.
 *
 * BOTH TOGETHER IS A CONFIGURATION ERROR, NOT A FALLBACK
 * A process that accepted a header *and* a token would be one where the weaker path decides,
 * because an attacker picks. `14` is specific that a development identity must never run where
 * real people have accounts, and "both are configured, the good one usually wins" is exactly the
 * arrangement that produces a header-authenticated production deployment nobody meant to make.
 */
function chooseAuthenticator(
  config: MainConfig,
  logger: Logger,
): ((request: FastifyRequest) => Promise<Principal | null>) | null {
  if (config.supabase !== null) {
    if (config.devAuth) {
      throw new Error(
        'Both KYNVIORA_SUPABASE_ISSUER and KYNVIORA_DEV_AUTH=1 are set. A process that accepts ' +
          'a header and a token is one where the weaker path decides, because an attacker picks ' +
          'which to present (spec 14). Configure exactly one.',
      );
    }
    return createSupabaseAuthenticator({
      issuer: config.supabase.issuer,
      audience: config.supabase.audience,
      jwks: httpJwks({ issuer: config.supabase.issuer, now: () => Date.parse(now()) }),
      now,
      // The reason never reaches the caller - `13` does not let this API be an oracle, and an
      // authentication endpoint is the most valuable place for one. It reaches the log instead,
      // where a deployment can see authentication failing and why.
      onRefusal: (reason) => {
        logger.warn('api.auth.refused', { reason });
      },
    });
  }

  // The flag is read from the config rather than from the environment a second time, so a test
  // can start a server without mutating `process.env` for every other test in the file.
  return createDevAuthenticator({ now, enabled: config.devAuth ? '1' : '' });
}

export interface StartedServer {
  readonly url: string;
  /**
   * Origin of the staff surface, or `null` when none was started.
   *
   * A separate origin rather than a path prefix, because that is what `13` asks for and what a
   * browser enforces: cookies, CORS and the console's own session are all scoped by origin, and
   * a staff path prefix on the household origin would share every one of them.
   */
  readonly staffUrl: string | null;
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

  const authenticate = chooseAuthenticator(config, logger);

  // Before anything is opened or bound. A deployment that has not accounted for retention is
  // misconfigured in a way no request will ever reveal (spec 16, DEC-121).
  assertRetentionAccountedFor(config.retention, config.production);

  if (authenticate === null && !config.allowAnonymousStart) {
    // A server that authenticates nobody serves nobody, and it fails in a way that looks like a
    // bug in every route rather than an absent configuration. Say which it is, once, here.
    throw new Error(
      'No authenticator is configured. Set KYNVIORA_SUPABASE_ISSUER to verify Supabase access ' +
        'tokens, KYNVIORA_DEV_AUTH=1 for header-based development identity (refused under ' +
        'NODE_ENV=production), or KYNVIORA_ALLOW_ANONYMOUS_START=1 to start a server that ' +
        'rejects every authenticated request on purpose.',
    );
  }

  const opened = await openRuntimeDb({
    dataDir: config.dataDir,
    connectionString: config.databaseUrl,
    managed: { applicationName: 'kynviora-api' },
  });
  const db: RuntimeDb = opened.db;

  // Which store this process attached to, once, before anything is served. An API that quietly
  // opened an empty local database when it was meant to reach a managed one looks exactly like a
  // database with no data in it, which is the slowest possible way to find out (spec 21).
  logger.info('api.database.opened', { kind: opened.kind, target: opened.describedAs });

  // Seeded here rather than by a separate command, on the connection this process already holds.
  // PGlite is a single writer: a standalone seed against the same directory as a running server
  // does not share its state, and the last process to exit overwrites the other. That failed
  // silently once, which is why it is no longer possible to do.
  if (config.seed) {
    const result = await db.withService((conn) => seedDevelopmentData(conn, now()));
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

  // The identity provider, where there is one. Two keys and one of them is a secret, so it is
  // built once here rather than reached for by a route - and it is `null` under the development
  // authenticator, which is what makes registration refuse rather than invent an address nobody
  // verified (DEC-125).
  const authProvider =
    config.supabase === null || config.supabase.anonKey === null
      ? null
      : supabaseAuthProvider({
          issuer: config.supabase.issuer,
          anonKey: config.supabase.anonKey,
          serviceKey: config.supabase.serviceKey ?? undefined,
          deletionFunctionUrl: config.supabase.deletionFunctionUrl ?? undefined,
          deletionSecret: config.supabase.deletionSecret ?? undefined,
        });

  if (config.supabase !== null) {
    // Which halves of the account lifecycle this deployment can perform. `14` keeps the key
    // server-side and out of every log; what is logged is whether one is present.
    logger.info('api.auth.provider', {
      directory: authProvider !== null,
      can_remove_identity: authProvider?.admin.canRemoveIdentity ?? false,
    });
  }

  const app = createServer({
    surface: 'HOUSEHOLD',
    authProvider,
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
    persisted: opened.kind === 'MANAGED_POSTGRES' || config.dataDir !== undefined,
  });

  // -------------------------------------------------------------------------
  // The staff surface
  // -------------------------------------------------------------------------
  // A second Fastify instance on a second port, sharing this process and this database.
  //
  // Two processes would be the deployment shape, and they cannot be the development shape here:
  // PGlite is a single writer (DEC-037), so a separate staff process pointed at the same data
  // directory does not share its state and the last one to exit overwrites the other. That has
  // already failed silently once. Two listeners in one process is the honest version of the same
  // boundary in this environment - the origin a phone talks to has no reviewer handler on it -
  // and it becomes two deployments unchanged when `BLK-001` clears and the store is a real
  // Postgres that more than one process can open.

  let staffApp: FastifyInstance | null = null;
  let staffUrl: string | null = null;

  if (config.staffPort !== null) {
    staffApp = createServer({
      surface: 'STAFF',
      pool: poolFor(db),
      logger,
      authenticate: authenticate ?? ((): Promise<Principal | null> => Promise.resolve(null)),
      now,
      loadSources,
    });

    await staffApp.listen({ port: config.staffPort, host: config.host });

    const staffAddress = staffApp.server.address();
    const staffBoundPort =
      typeof staffAddress === 'object' && staffAddress !== null
        ? staffAddress.port
        : config.staffPort;

    staffUrl = `http://${config.host}:${String(staffBoundPort)}`;

    // Worth a line of its own. An operator reading the log should be able to see that a staff
    // origin exists and on which port, because the whole point of the split is that its presence
    // is a decision rather than an accident.
    logger.info('staff_api.started', { port: staffBoundPort, dev_auth: config.devAuth });
  }

  // -------------------------------------------------------------------------
  // Retention
  // -------------------------------------------------------------------------
  // In this process, when asked for. Two processes would be the deployment shape and cannot be
  // the development shape here for the reason the staff surface gives above: PGlite is a single
  // writer (DEC-037), so a separate worker pointed at the same data directory would purge from a
  // stale copy and write it back over everything this process had done. `services/worker`
  // therefore has its own entry point that refuses a local data directory, and this is the mode
  // that actually sweeps today.
  //
  // Nothing is started for `external` - the deployment has said something else does it - or for
  // `none`, which `assertRetentionAccountedFor` has already refused in production.

  let retentionLoop: RetentionLoop | null = null;

  if (config.retention.mode === 'worker') {
    const retentionConfig = readRetentionWorkerConfig();
    retentionLoop = startRetentionLoop({
      db,
      config: retentionConfig,
      clock,
      logger,
      ids: cryptoIdGenerator(randomUUID),
    });
    logger.info('retention.hosted', {
      holder: retentionLoop.holder,
      interval_ms: retentionConfig.intervalMs,
    });
  }

  return {
    url: `http://${config.host}:${String(boundPort)}`,
    staffUrl,
    stop: async () => {
      // First. The loop holds a lease and a connection, and closing the database underneath it
      // would turn an orderly shutdown into a run recorded as failed.
      if (retentionLoop !== null) await retentionLoop.stop();
      if (staffApp !== null) await staffApp.close();
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
      if (server.staffUrl !== null) {
        process.stdout.write(`Kynviora staff API listening on ${server.staffUrl}\n`);
      }
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
