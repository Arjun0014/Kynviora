/**
 * A switch between the phone and the API, so "offline" is a state this harness sets.
 *
 * Spec references: `12`, `13`, `19` ("Offline create/edit/sync", "network disruption"), DEC-111.
 *
 * WHY NOT JUST REMOVE THE TUNNEL
 * Because it does not make the phone offline, and believing it does produced a run that measured
 * nothing. `adb reverse --remove` takes away adbd's listener, but OkHttp's already-established
 * connections keep working - so a save meant to be queued went straight to the server, the server
 * changed, and the scenario read as "the edit arrived", which was true and was not the claim.
 *
 * Requests go device -> `adb reverse tcp:3000 tcp:<port>` -> the switch -> the real API. The phone
 * still addresses `127.0.0.1:3000`, so the client's loopback rule holds and no development
 * identity header leaves the adb channel (`config.ts`, DEC-038).
 *
 * THE THIRD MODE IS THE REASON THIS EXISTS
 * `swallow` forwards the request, waits for the server to answer - so the write is committed - and
 * then destroys the socket without passing the answer back. That is the one case `OFFLINE` cannot
 * distinguish and the one DEC-111 was written for: the client infers "it never arrived" from a
 * failed fetch, which is also what an arrival whose answer was lost looks like. Without a way to
 * produce it, "the replay keeps the key" is untestable from outside the app.
 *
 * THIS FILE IS THE HANDLE; THE SWITCH IS A SEPARATE PROCESS
 * `apiSwitchServer.ts` says why in full. In short: the harness blocks its own event loop for most
 * of a run, so a server in the same process would serve nothing while the app is starting - and
 * every reading taken through it would be about the harness rather than the app. The two talk
 * through files because that is the only channel a blocked process can still use.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sleep } from './adb.js';
import type { ObservedRequest } from './offlineWrites.js';

export type SwitchMode =
  /** Forward everything, both ways. */
  | 'pass'
  /** Refuse new connections and destroy live ones: the phone has no network. */
  | 'offline'
  /** Forward the request, let the server commit, then drop the answer on the floor. */
  | 'swallow';

export interface ApiSwitch {
  /**
   * Change what the switch does, and wait until it has.
   *
   * Blocking on the acknowledgement rather than firing and hoping: the next thing a caller does is
   * tap Save, and a request that beat the mode change would be recorded as having reached a server
   * that was supposed to be unreachable.
   */
  readonly setMode: (mode: SwitchMode) => boolean;
  /** Every request that went past since the last `clear`. */
  readonly seen: () => readonly ObservedRequest[];
  readonly clear: () => void;
  readonly close: () => void;
}

export interface ApiSwitchOptions {
  /** Where this listens. The phone reaches it through `adb reverse`. */
  readonly port: number;
  /** The real API. */
  readonly upstreamPort: number;
}

/** Read the appended record, tolerating a line the child was midway through writing. */
function readSeen(file: string): readonly ObservedRequest[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  const found: ObservedRequest[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      found.push(JSON.parse(line) as ObservedRequest);
    } catch {
      // A partially written final line. There is no need to wait for it: whatever it is, it will
      // be complete by the next read, and a torn line is never the only evidence for a check.
    }
  }
  return found;
}

export function startApiSwitch(options: ApiSwitchOptions): ApiSwitch {
  const directory = mkdtempSync(join(tmpdir(), 'kynviora-switch-'));
  mkdirSync(directory, { recursive: true });

  const modeFile = join(directory, 'mode');
  const ackFile = join(directory, 'mode.ack');
  const seenFile = join(directory, 'seen.jsonl');
  const readyFile = join(directory, 'ready');

  writeFileSync(modeFile, 'pass', 'utf8');
  writeFileSync(seenFile, '', 'utf8');

  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      join(import.meta.dirname, 'apiSwitchServer.ts'),
      directory,
      String(options.port),
      String(options.upstreamPort),
    ],
    { stdio: 'inherit', detached: false },
  );

  // Synchronous on purpose, like everything else here: nothing may be driven at the device until
  // the switch is actually in the path.
  const deadline = Date.now() + 30_000;
  while (!existsSync(readyFile) && Date.now() < deadline) sleep(200);
  if (!existsSync(readyFile)) {
    child.kill();
    throw new Error(`The API switch did not start on port ${String(options.port)}.`);
  }

  let watermark = 0;

  return {
    setMode: (next) => {
      writeFileSync(modeFile, next, 'utf8');
      const until = Date.now() + 10_000;
      while (Date.now() < until) {
        try {
          if (readFileSync(ackFile, 'utf8').trim() === next) return true;
        } catch {
          // Not written yet.
        }
        sleep(100);
      }
      return false;
    },
    seen: () => readSeen(seenFile).slice(watermark),
    clear: () => {
      watermark = readSeen(seenFile).length;
    },
    close: () => {
      child.kill();
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // A temporary directory that outlives a run is not worth failing one over.
      }
    },
  };
}
