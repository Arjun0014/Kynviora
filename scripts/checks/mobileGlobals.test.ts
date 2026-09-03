/**
 * The rule, and then the app measured against it.
 *
 * The last test is the one that matters: it reads the real `apps/mobile/src` tree, which no other
 * test in this suite does, and it is the only thing in `npm run verify` that would have caught
 * `crypto.randomUUID()` sitting in eight screens (`DEV-043`).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  FORBIDDEN_GLOBALS,
  describeForbiddenGlobals,
  forbiddenGlobalsIn,
  stripCommentsAndStrings,
} from './mobileGlobals.js';

const MOBILE_SOURCE = join(process.cwd(), 'apps', 'mobile', 'src');

function sourceFilesUnder(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFilesUnder(path));
    } else if (/\.tsx?$/.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

describe('stripCommentsAndStrings', () => {
  it('removes line and block comments', () => {
    const cleaned = stripCommentsAndStrings('// crypto\n/* crypto */\nconst a = 1;');
    expect(cleaned).not.toContain('crypto');
    expect(cleaned).toContain('const a = 1;');
  });

  it('removes every kind of string literal', () => {
    const cleaned = stripCommentsAndStrings(
      'import x from \'expo-crypto\';\nconst b = "crypto";\nconst c = `crypto`;',
    );
    expect(cleaned).not.toContain('crypto');
  });

  it('leaves code that is not a comment or a string', () => {
    expect(stripCommentsAndStrings('const key = crypto.randomUUID();')).toContain('crypto');
  });

  it('keeps every line break, so a reported line is the line in the file', () => {
    // The regression that made the first version of this check report the real defect seventy
    // lines above itself. Every file here opens with a long block comment.
    const source = '/**\n * a\n * b\n */\nconst key = crypto.randomUUID();\n';
    expect(stripCommentsAndStrings(source).split('\n')).toHaveLength(source.split('\n').length);
    expect(forbiddenGlobalsIn(source)).toEqual([{ name: 'crypto', line: 5 }]);
  });
});

describe('forbiddenGlobalsIn', () => {
  it('finds a bare read of a forbidden global, with its line', () => {
    const found = forbiddenGlobalsIn('const a = 1;\nconst key = crypto.randomUUID();\n');
    expect(found).toEqual([{ name: 'crypto', line: 2 }]);
  });

  it('does not report a property access on something else', () => {
    // The distinction the whole check rests on: `Crypto` is a module somebody imported and named,
    // `crypto` is a global nobody defined.
    expect(forbiddenGlobalsIn("import * as Crypto from 'x';\nCrypto.randomUUID();\n")).toEqual([]);
    expect(forbiddenGlobalsIn('globalThis.crypto.randomUUID();\n')).toEqual([]);
  });

  it('does not report an object key or a type annotation', () => {
    expect(forbiddenGlobalsIn('const shim = { crypto: fake };\n')).toEqual([]);
  });

  it('does not report a name that merely contains a forbidden one', () => {
    expect(forbiddenGlobalsIn('const cryptoKeyLength = 32;\nuseCrypto();\n')).toEqual([]);
  });

  it('reports each forbidden name it is given', () => {
    const found = forbiddenGlobalsIn('document.title;\nlocalStorage.getItem("a");\n');
    expect(found.map((use) => use.name)).toEqual(['document', 'localStorage']);
  });

  it('names the failure in terms of when it goes wrong', () => {
    const described = describeForbiddenGlobals('a.tsx', [{ name: 'crypto', line: 2 }]);
    expect(described[0]).toContain('a.tsx:2');
    expect(described[0]).toContain('React Native does not define');
  });
});

describe('the mobile app', () => {
  it('has source to check, so a pass is not a pass over nothing', () => {
    // The absence test that makes the next one mean something (DEC-102). A moved directory or a
    // changed working directory would otherwise report a clean app by finding no app at all.
    expect(sourceFilesUnder(MOBILE_SOURCE).length).toBeGreaterThan(20);
  });

  it('reads no global that React Native does not define', () => {
    const failures: string[] = [];
    for (const file of sourceFilesUnder(MOBILE_SOURCE)) {
      const uses = forbiddenGlobalsIn(readFileSync(file, 'utf8'), FORBIDDEN_GLOBALS);
      failures.push(...describeForbiddenGlobals(relative(process.cwd(), file), uses));
    }
    expect(failures).toEqual([]);
  });
});
