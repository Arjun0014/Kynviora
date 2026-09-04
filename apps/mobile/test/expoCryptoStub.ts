/**
 * What `expo-crypto` is, for a test.
 *
 * Spec references: `07` (identifiers must be non-guessable), `13`, `DEV-043`.
 *
 * The real module is a thin binding onto the platform's secure random source, and importing it in
 * Node fails before it does anything useful: `expo-modules-core` reads `__DEV__` at module scope
 * and expects a native runtime underneath.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM
 * That the values are secure. They are not, and they must never be used for anything but a test:
 * `07`'s requirement is about the identifiers a real device mints, and `ids.ts` says in its own
 * comment why `Math.random()` has the right shape and none of the property that matters. What
 * these tests are about is whether a key is minted **once per intent** and reused on a replay
 * (DEC-111) - which is a question about call sites, and is answered the same way whatever the
 * bytes are. The counter makes each value distinguishable so a test can tell two intents apart.
 */

let counter = 0;

function nextHex(length: number): string {
  counter += 1;
  return counter.toString(16).padStart(length, '0').slice(-length);
}

/** Shaped as a v4 UUID so anything validating the format sees what it expects. */
export function randomUUID(): string {
  return `${nextHex(8)}-${nextHex(4)}-4${nextHex(3)}-8${nextHex(3)}-${nextHex(12)}`;
}

export function getRandomBytesAsync(count: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    counter += 1;
    bytes[index] = counter % 256;
  }
  return Promise.resolve(bytes);
}

export const CryptoDigestAlgorithm = { SHA256: 'SHA-256' } as const;

/**
 * A deterministic stand-in for a digest.
 *
 * Not SHA-256. A Visit Pack's canonical digest is checked by the server, so what a client test can
 * usefully say is that the same canonical string produces the same value and a different one does
 * not - which this satisfies and a real hash would satisfy no better.
 */
export function digestStringAsync(_algorithm: string, canonical: string): Promise<string> {
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return Promise.resolve(hash.toString(16).padStart(64, '0'));
}

export function resetIdCounter(): void {
  counter = 0;
}
