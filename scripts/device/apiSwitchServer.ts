/**
 * The switch itself, run as its own process.
 *
 * Spec references: `12`, `13`, `19` ("Offline create/edit/sync", "network disruption"), DEC-111.
 *
 * WHY THIS IS NOT IN THE HARNESS PROCESS, WHICH IS THE WHOLE POINT OF THE FILE
 * `sleep` in `adb.ts` is `Atomics.wait` - synchronous on purpose, so that a failure can be
 * attributed to the step that caused it. It also blocks the event loop, for forty-five seconds at
 * a stretch while an app starts. An HTTP server in that same process cannot accept a connection
 * during any of it, which is almost the whole run.
 *
 * That is not a subtle degradation. The phone's requests sit in the accept backlog until the
 * harness happens to be between sleeps, so the app renders "No connection. Kynviora could not
 * reach the internet" on a launch the harness believes is online - and requests made while the
 * switch was supposed to be *offline* are served later, when it is back to passing them, and
 * recorded as having got through. Both readings are wrong and both look like findings about the
 * app. This process does nothing but serve, so it is never blocked.
 *
 * HOW IT IS CONTROLLED
 * Through files, and that is also forced by the same fact. The parent cannot receive a message,
 * answer a socket or flush a pipe while it is blocked, but `readFileSync` and `writeFileSync` are
 * syscalls and need no event loop at all. So: the parent writes `mode`, this process polls it and
 * writes `mode.ack` back; this process appends what it saw to `seen.jsonl`, and the parent reads
 * that file whenever it likes.
 *
 *   tsx scripts/device/apiSwitchServer.ts <directory> <listen port> <upstream port>
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import type { Socket } from 'node:net';
import type { SwitchMode } from './apiSwitch.js';

const [directory, listenPort, upstreamPort] = process.argv.slice(2);
if (directory === undefined || listenPort === undefined || upstreamPort === undefined) {
  process.stderr.write('usage: apiSwitchServer <directory> <listenPort> <upstreamPort>\n');
  process.exit(2);
}

const MODE_FILE = join(directory, 'mode');
const ACK_FILE = join(directory, 'mode.ack');
const SEEN_FILE = join(directory, 'seen.jsonl');
const READY_FILE = join(directory, 'ready');

let mode: SwitchMode = 'pass';
const live = new Set<Socket>();

function headerValue(raw: string | string[] | undefined): string | null {
  if (raw === undefined) return null;
  if (typeof raw === 'string') return raw;
  return raw[0] ?? null;
}

const server = createServer((incoming, outgoing) => {
  if (mode === 'offline') {
    incoming.socket.destroy();
    return;
  }

  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port: Number(upstreamPort),
      method: incoming.method,
      path: incoming.url,
      headers: incoming.headers,
    },
    (answer) => {
      const chunks: Buffer[] = [];
      answer.on('data', (chunk: Buffer) => chunks.push(chunk));
      answer.on('end', () => {
        // Recorded when the answer arrives rather than when the request goes out, so the record
        // carries what the server decided - which is the whole evidence for OFF-4.
        appendFileSync(
          SEEN_FILE,
          `${JSON.stringify({
            method: incoming.method ?? '',
            path: incoming.url ?? '',
            status: answer.statusCode ?? 0,
            replay: headerValue(answer.headers['idempotent-replay']),
            key: headerValue(incoming.headers['idempotency-key']),
          })}\n`,
          'utf8',
        );

        if (mode === 'swallow') {
          // The server has answered - so it has committed - and the phone will never hear it.
          // This is the case `OFFLINE` cannot distinguish and the one DEC-111 exists for.
          incoming.socket.destroy();
          return;
        }
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
        outgoing.end(Buffer.concat(chunks));
      });
    },
  );

  // A refused upstream is the phone's "no network" too, and must not become a 502 the client would
  // read as a server that answered.
  upstream.on('error', () => {
    incoming.socket.destroy();
  });
  incoming.pipe(upstream);
});

server.on('connection', (socket: Socket) => {
  live.add(socket);
  socket.on('close', () => live.delete(socket));
  if (mode === 'offline') socket.destroy();
});

/**
 * Poll the mode file and acknowledge what was applied.
 *
 * The acknowledgement is what lets the parent know the switch is really offline before it taps
 * Save. Without it the parent would be racing this poll, and a request that slipped through would
 * read as "the app was never offline" - a finding about the harness wearing a finding about the
 * app.
 */
setInterval(() => {
  let wanted: string;
  try {
    wanted = readFileSync(MODE_FILE, 'utf8').trim();
  } catch {
    return;
  }
  if (wanted === mode || (wanted !== 'pass' && wanted !== 'offline' && wanted !== 'swallow')) {
    return;
  }
  mode = wanted;
  if (mode === 'offline') for (const socket of live) socket.destroy();
  writeFileSync(ACK_FILE, mode, 'utf8');
}, 100);

server.listen(Number(listenPort), '127.0.0.1', () => {
  writeFileSync(ACK_FILE, mode, 'utf8');
  writeFileSync(READY_FILE, String(process.pid), 'utf8');
});
