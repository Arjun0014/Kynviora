/**
 * What a component test gets when it reaches the platform.
 *
 * Spec references: `12`, `14` (encrypted local storage; the keystore), `19`, DEC-102.
 *
 * The stubs beside this file exist so a screen module can be **imported** in Node: a screen
 * imports its providers, a provider imports `expo-secure-store` or `expo-sqlite`, and
 * `expo-modules-core` reads a global the native runtime installs - at module scope, so the import
 * throws before any test has rendered anything.
 *
 * They are not there to be called, and calling one throws on purpose. A component test that
 * reached the keystore or opened a database would be measuring something it cannot measure:
 * `verify:device` is what proves the store is encrypted, that its key is keystore-wrapped and that
 * the file gives up nothing, and a stub returning plausible values would let a test in Node claim
 * coverage of exactly that. "Could not look" must never be recorded as "looked and it was fine"
 * (DEC-102), and the loudest version of that here is a thrown error naming the call.
 */
export function unavailable(module: string, member: string): never {
  throw new Error(
    `${module}.${member} was called in a component test. Nothing in Node can stand in for the ` +
      `platform here, and a stub returning a plausible value would let this test claim coverage ` +
      `of something only \`npm run verify:device\` can measure.`,
  );
}
