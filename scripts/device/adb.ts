/**
 * The one place this harness talks to a device.
 *
 * Kept apart from the files that decide what output means, so those stay runnable with no device
 * attached and are covered by `npm run verify` (DEC-102).
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export const PACKAGE = 'com.kynviora.app';

export function adbPath(): string {
  const home = process.env['ANDROID_HOME'] ?? process.env['ANDROID_SDK_ROOT'];
  if (home === undefined || home === '') return 'adb';
  return join(home, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
}

export interface AdbResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export function adb(args: readonly string[]): AdbResult {
  const result = spawnSync(adbPath(), [...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    return { ok: false, stdout: '', stderr: result.error.message };
  }
  return {
    ok: result.status === 0,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

/**
 * `adb exec-out`, whose stream is not line-ending mangled.
 *
 * `adb shell` rewrites LF to CRLF on some platforms, which would corrupt every byte of a database
 * and turn the encryption checks into noise.
 */
export function adbBytes(args: readonly string[]): Uint8Array | null {
  const result = spawnSync(adbPath(), [...args], { maxBuffer: 256 * 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0) return null;
  const out = result.stdout;
  if (out === null || out.length === 0) return null;
  return new Uint8Array(out);
}

export function isInstalled(): boolean {
  return adb(['shell', 'pm', 'path', PACKAGE]).stdout.includes('package:');
}

/** The device's density bucket, which is what turns reported pixels into dp. */
export function densityDpi(): number {
  const raw = adb(['shell', 'wm', 'density']).stdout;
  const match = /Physical density:\s*(\d+)/.exec(raw);
  return match === null ? 160 : Number(match[1]);
}

/** The system font scale currently in force. Absent means the platform default of 1. */
export function fontScale(): number {
  const raw = adb(['shell', 'settings', 'get', 'system', 'font_scale']).stdout.trim();
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export function setFontScale(scale: number): void {
  adb(['shell', 'settings', 'put', 'system', 'font_scale', scale.toFixed(2)]);
}

/** The rendered view hierarchy, or `null` where it could not be captured. */
export function dumpUiHierarchy(): string | null {
  const bytes = adbBytes(['exec-out', 'uiautomator', 'dump', '/dev/tty']);
  if (bytes === null) return null;
  const text = new TextDecoder().decode(bytes);
  return text.includes('<node') ? text : null;
}

export function sleep(ms: number): void {
  // Synchronous on purpose: this harness is a sequence of device interactions, and interleaving
  // them would make a failure impossible to attribute to the step that caused it.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
