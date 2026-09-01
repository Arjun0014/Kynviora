/**
 * The reviewer console entry point.
 *
 * Spec references: `13` (HTTPS, environment isolation, session expiration), `14` (reviewer/admin
 * security), `21` (environments), `DEV-016`, `BLK-010`.
 *
 * Run it beside a staff API surface:
 *
 * ```bash
 * KYNVIORA_DEV_AUTH=1 KYNVIORA_DEV_SEED=1 KYNVIORA_STAFF_PORT=3100 npm run dev
 * KYNVIORA_STAFF_API_URL=http://127.0.0.1:3100 npm run dev:console
 * ```
 *
 * Three origins: the household API on 3000, the staff API on 3100, this on 4100.
 *
 * WHAT IT REFUSES TO DO
 * It will not start against the household API's origin, and it will not start against a remote
 * origin over plaintext. The first is the mistake this whole phase is about; the second is `13`'s
 * HTTPS rule on the surface that can publish safety content.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  systemClock,
  type Clock,
  type Instant,
  type LogFields,
  type Logger,
} from '@kynviora/domain';
import {
  DEFAULT_STAFF_TIMEOUT_MS,
  resolveStaffApiBaseUrl,
  StaffConfigRefused,
} from '@kynviora/staff-console';
import { createConsoleServer } from './server.js';

export interface ConsoleConfig {
  readonly port: number;
  readonly host: string;
  readonly apiBaseUrl: string;
  readonly timeoutMs: number;
  readonly secureCookie: boolean;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer; got ${JSON.stringify(raw)}.`);
  }
  return value;
}

export function readConsoleConfig(): ConsoleConfig {
  const raw = process.env.KYNVIORA_STAFF_API_URL;
  if (raw === undefined || raw.trim() === '') {
    throw new StaffConfigRefused(
      'KYNVIORA_STAFF_API_URL is not set. There is deliberately no default: a console that ' +
        'silently pointed at the household API would send a reviewer session to the origin a ' +
        'phone talks to, which is the mistake spec 13 is about.',
    );
  }

  // Passed so the console refuses to run against the household origin. Optional, because a
  // deployment may not have the household URL to hand - the refusal it enables is the one that
  // matters in development, where both are on loopback and one digit apart.
  const household = process.env.KYNVIORA_HOUSEHOLD_API_URL;
  const apiBaseUrl = resolveStaffApiBaseUrl(raw.trim(), household);

  return {
    port: readNumber('KYNVIORA_CONSOLE_PORT', 4100),
    host: process.env.KYNVIORA_CONSOLE_HOST ?? '127.0.0.1',
    apiBaseUrl,
    timeoutMs: readNumber('KYNVIORA_CONSOLE_TIMEOUT_MS', DEFAULT_STAFF_TIMEOUT_MS),
    // The cookie is marked `Secure` wherever the console is not on loopback. A `Secure` cookie is
    // simply not sent over plaintext, so setting it unconditionally would break loopback
    // development in a way that looks like a broken session.
    secureCookie: !(process.env.KYNVIORA_CONSOLE_HOST ?? '127.0.0.1').startsWith('127.'),
  };
}

export function consoleLogger(clockFor: Clock): Logger {
  const emit =
    (level: string) =>
    (code: string, fields?: LogFields): void => {
      const record = { level, code, ...(fields ?? {}), at: clockFor.now() };
      process.stdout.write(`${JSON.stringify(record)}\n`);
    };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

const clock: Clock = systemClock();
const now = (): Instant => clock.now();

export interface StartedConsole {
  readonly url: string;
  stop(): Promise<void>;
}

export async function startConsole(
  config: ConsoleConfig = readConsoleConfig(),
  overrides: { readonly logger?: Logger } = {},
): Promise<StartedConsole> {
  const logger = overrides.logger ?? consoleLogger(clock);

  const app = createConsoleServer({
    config: { apiBaseUrl: config.apiBaseUrl, timeoutMs: config.timeoutMs },
    logger,
    now,
    secureCookie: config.secureCookie,
  });

  await app.listen({ port: config.port, host: config.host });

  const address = app.server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : config.port;

  logger.info('staff_console.started', { port: boundPort });

  return {
    url: `http://${config.host}:${String(boundPort)}`,
    stop: () => app.close(),
  };
}

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
  startConsole().then(
    (server) => {
      const shutdown = (): void => {
        void server.stop().then(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      process.stdout.write(`Kynviora reviewer console listening on ${server.url}\n`);
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `${error instanceof StaffConfigRefused ? 'Refused' : 'Failed'}: ${message}\n`,
      );
      process.exit(1);
    },
  );
}
