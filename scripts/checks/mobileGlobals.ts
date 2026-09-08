/**
 * The globals a phone does not have, and the check that the app does not reach for them.
 *
 * Spec references: `12` (the client is a device, not a browser), `07` (non-guessable identifiers),
 * `DEV-043`, trap 164.
 *
 * WHY THIS EXISTS SOMEWHERE THAT IS NOT `apps/**`
 * `apps/**` is outside the test run (`vitest.config.ts`) and outside the lint run
 * (`eslint.config.js` ignores it), so a rule written there is a rule nothing checks. It is also
 * the one tree whose code runs on Hermes, where the web platform is absent - and the two facts
 * together are how `crypto.randomUUID()` came to sit in eight call sites, typechecking against
 * Expo's `lib: ["DOM"]` and throwing `Property 'crypto' doesn't exist` the moment somebody pressed
 * Save. Nothing on this machine could have told anyone: every gate the project runs was green.
 *
 * The mobile `tsconfig.json` now compiles with no DOM and no ambient Node types, which makes each
 * of these a compile error. This check is the same rule stated where the suite can run it, so that
 * it survives somebody restoring a convenient `lib` and so that the reason is written down next to
 * the names rather than inferred from a compiler flag.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not parse. Comments and string literals are removed and the remainder is searched for
 * whole-word reads of the forbidden names, which is enough for the question being asked - "does
 * this file mention a global that is not there?" - and stops well short of pretending to be a
 * type system. A name that is genuinely absent from a file cannot be missed by it; a name used as
 * an object key or a property is not a global read and is not reported.
 */

/**
 * Globals the web platform defines, React Native does not, and this app must therefore not read.
 *
 * Each is here because its absence is silent until somebody exercises the screen on hardware.
 * `navigator`, `fetch`, `URL`, `AbortController`, `console` and the timers are **not** here: React
 * Native provides them, and a check that forbade them would be wrong rather than strict.
 */
export const FORBIDDEN_GLOBALS: readonly string[] = [
  'crypto',
  'document',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'XMLHttpRequest',
];

/**
 * Blank out comments and string literals, keeping every line break.
 *
 * Both can legitimately contain any of these names - `'expo-crypto'` is an import specifier, and
 * the note above this constant says "crypto" repeatedly - and a check that flagged them would be
 * one people learn to work around by rephrasing prose.
 *
 * The newlines are preserved rather than collapsed, and that is not tidiness. Every file in this
 * project opens with a long block comment; replacing one with a single space moves every line
 * after it, and the first version of this check reported the real defect seventy lines above where
 * it was. A finding somebody cannot find is barely better than no finding.
 */
export function stripCommentsAndStrings(source: string): string {
  const blank = (match: string): string => match.replace(/[^\n]/g, ' ');
  return (
    source
      .replace(/\/\*[\s\S]*?\*\//g, blank)
      .replace(/\/\/[^\n]*/g, blank)
      .replace(/`(?:\\[\s\S]|[^\\`])*`/g, blank)
      .replace(/'(?:\\[\s\S]|[^\\'])*'/g, blank)
      .replace(/"(?:\\[\s\S]|[^\\"])*"/g, blank)
      // JSX text, which is the fourth place a word can appear without being code and was the one
      // this check did not know about. A sentence a person reads on screen is written bare between
      // two tags - `<Typography>The document itself is what was kept.</Typography>` - so it survives
      // every rule above, and the check reported the app as reading `document` on a line that
      // renders a sentence about a lab report.
      //
      // Only a run that provably contains no code is blanked: a brace anywhere between the tags
      // means an embedded expression, and blanking that would be a false negative - the one kind of
      // mistake this check must not make. So `>Some words<` is blanked and
      // `>{crypto.randomUUID()}<` is left exactly as it was.
      .replace(/>[^<>{}]+</g, (run) => `>${blank(run.slice(1, -1))}<`)
  );
}

/** One forbidden read, with enough to find it. */
export interface ForbiddenGlobalUse {
  readonly name: string;
  /** 1-indexed, so it matches what an editor shows. */
  readonly line: number;
}

/**
 * Find reads of a forbidden global in one file's source.
 *
 * A name preceded by `.` is a property access on something else (`Crypto.randomUUID`,
 * `globalThis.crypto`) and a name followed by `:` is an object key or a type annotation; neither
 * is a bare global read, and neither is reported. `import * as Crypto` survives for the same
 * reason the list is case-sensitive: `Crypto` is a module somebody named, `crypto` is a global
 * nobody defined.
 */
export function forbiddenGlobalsIn(
  source: string,
  forbidden: readonly string[] = FORBIDDEN_GLOBALS,
): readonly ForbiddenGlobalUse[] {
  const cleaned = stripCommentsAndStrings(source);
  const found: ForbiddenGlobalUse[] = [];

  for (const name of forbidden) {
    const pattern = new RegExp(`(^|[^.\\w$])${name}\\b(?!\\s*:)`, 'g');
    for (const match of cleaned.matchAll(pattern)) {
      const before = cleaned.slice(0, match.index);
      found.push({ name, line: before.split('\n').length });
    }
  }

  return found.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

/** Render a file's findings as something a person can act on. */
export function describeForbiddenGlobals(
  file: string,
  uses: readonly ForbiddenGlobalUse[],
): readonly string[] {
  return uses.map(
    (use) =>
      `${file}:${String(use.line)} reads the global \`${use.name}\`, which React Native does not ` +
      'define. On a device this throws when the code runs, not when it is built.',
  );
}
