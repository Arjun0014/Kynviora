/**
 * Which theme the app wears, and what it does when nobody has said.
 *
 * Spec references: `18` (appearance and motion are accessibility settings), `12`, DEC-130.
 *
 * WHAT A TEST HERE CAN AND CANNOT SHOW
 * It can show which theme is resolved from a choice and a system setting, that the choice is read
 * back from the store, and that a screen re-styles when it changes. It cannot show that either
 * theme is legible on a phone: contrast is arithmetic, asserted in `packages/presentation`, and
 * whether a control is still 48dp and unclipped in dark mode at 2x is a device question (`19`).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Text } from 'react-native';
import {
  setColorScheme,
  resetColorScheme,
  setReduceMotion,
  resetReduceMotion,
} from '../../test/reactNativeStub';
import { DARK_THEME, LIGHT_THEME } from '@kynviora/presentation';
import { renderScreen, flush, textOf, allNodes, type Rendered } from '../../test/render';
import { LocalStoreProvider, type LocalStoreContextValue } from '@/storage/LocalStoreProvider';
import type { PreferenceKey, PreferenceStore } from '@/storage/preferences';
import {
  ThemeProvider,
  resolveThemeName,
  useTheme,
  useThemeContext,
  isAppearanceChoice,
  type AppearanceChoice,
} from './ThemeProvider';

beforeEach(() => {
  resetColorScheme();
  resetReduceMotion();
});

/** A preference store held in a map, which is what one is. */
function storeHolding(initial: Partial<Record<PreferenceKey, string>> = {}): {
  readonly preferences: PreferenceStore;
  readonly written: Map<string, string>;
} {
  const written = new Map<string, string>(Object.entries(initial));
  return {
    written,
    preferences: {
      read: (key) => Promise.resolve(written.get(key) ?? null),
      write: (key, value) => {
        written.set(key, value);
        return Promise.resolve();
      },
      forget: (key) => {
        written.delete(key);
        return Promise.resolve();
      },
    },
  };
}

function storeValue(preferences: PreferenceStore | null): LocalStoreContextValue {
  return {
    projection: null,
    pending: null,
    session: null,
    preferences,
    settled: true,
    error: null,
  };
}

function Probe() {
  const theme = useTheme();
  const { choice, reduceMotion } = useThemeContext();
  return <Text>{[theme.name, choice, String(reduceMotion)].join('|')}</Text>;
}

function readProbe(rendered: Rendered): string {
  return allNodes(rendered)
    .filter((node) => String(node.type) === 'Text')
    .map((node) => textOf(node))
    .join('');
}

describe('resolveThemeName', () => {
  it('follows the system when that is the choice', () => {
    expect(resolveThemeName('FOLLOW_SYSTEM', 'dark')).toBe('DARK');
    expect(resolveThemeName('FOLLOW_SYSTEM', 'light')).toBe('LIGHT');
  });

  it('ignores the system when a person has chosen', () => {
    // The point of the third state. Somebody who chose light stays light when their phone
    // switches itself at dusk; somebody following the system does not.
    expect(resolveThemeName('LIGHT', 'dark')).toBe('LIGHT');
    expect(resolveThemeName('DARK', 'light')).toBe('DARK');
  });

  it('resolves a platform that did not answer to light', () => {
    // `null` and `unspecified` both mean "this platform did not say", and the darker of the two
    // answers is the one that changes more about a screen - so the quieter guess is the safer.
    expect(resolveThemeName('FOLLOW_SYSTEM', null)).toBe('LIGHT');
    expect(resolveThemeName('FOLLOW_SYSTEM', undefined)).toBe('LIGHT');
    expect(resolveThemeName('FOLLOW_SYSTEM', 'unspecified')).toBe('LIGHT');
  });
});

describe('isAppearanceChoice', () => {
  it('accepts the three choices and nothing else', () => {
    for (const choice of ['FOLLOW_SYSTEM', 'LIGHT', 'DARK'] as const) {
      expect(isAppearanceChoice(choice)).toBe(true);
    }
    // A stored value from a build that wrote something else must not become a theme.
    expect(isAppearanceChoice('SEPIA')).toBe(false);
    expect(isAppearanceChoice(null)).toBe(false);
    expect(isAppearanceChoice(1)).toBe(false);
  });
});

describe('ThemeProvider', () => {
  it('paints the system theme before the stored choice has been read', () => {
    // The reason it sits inside the store rather than waiting for it: the system's answer is
    // available on the first frame, so a person in dark mode never sees a white flash.
    setColorScheme('dark');
    const { preferences } = storeHolding();
    const rendered = renderScreen(
      <LocalStoreProvider value={storeValue(preferences)}>
        <ThemeProvider>
          <Probe />
        </ThemeProvider>
      </LocalStoreProvider>,
    );
    expect(readProbe(rendered)).toContain('DARK|FOLLOW_SYSTEM');
  });

  it('reads a stored choice back and lets it override the system', async () => {
    setColorScheme('dark');
    const { preferences } = storeHolding({ appearance: 'LIGHT' });
    const rendered = renderScreen(
      <LocalStoreProvider value={storeValue(preferences)}>
        <ThemeProvider>
          <Probe />
        </ThemeProvider>
      </LocalStoreProvider>,
    );
    await flush();
    expect(readProbe(rendered)).toContain('LIGHT|LIGHT');
  });

  it('ignores a stored value this build does not recognise', async () => {
    // A theme is not something to guess at from a string an older or newer build wrote.
    setColorScheme('dark');
    const { preferences } = storeHolding({ appearance: 'SEPIA' });
    const rendered = renderScreen(
      <LocalStoreProvider value={storeValue(preferences)}>
        <ThemeProvider>
          <Probe />
        </ThemeProvider>
      </LocalStoreProvider>,
    );
    await flush();
    expect(readProbe(rendered)).toContain('DARK|FOLLOW_SYSTEM');
  });

  it('settles, and stays usable, when there is no store to read from', async () => {
    // A device whose keystore refuses still has to show the app. The theme is the system's, and
    // the setting simply does not persist.
    const rendered = renderScreen(
      <LocalStoreProvider value={storeValue(null)}>
        <ThemeProvider>
          <Probe />
        </ThemeProvider>
      </LocalStoreProvider>,
    );
    await flush();
    expect(readProbe(rendered)).toContain('LIGHT|FOLLOW_SYSTEM');
  });

  it('stores a choice, and shows it before the write has finished', async () => {
    const { preferences, written } = storeHolding();
    const choosers: ((choice: AppearanceChoice) => void)[] = [];

    function Control() {
      const context = useThemeContext();
      choosers.push(context.setChoice);
      return <Text>{context.theme.name}</Text>;
    }

    const rendered = renderScreen(
      <LocalStoreProvider value={storeValue(preferences)}>
        <ThemeProvider>
          <Control />
        </ThemeProvider>
      </LocalStoreProvider>,
    );
    await flush();
    expect(readProbe(rendered)).toBe('LIGHT');

    const choose = choosers.at(-1);
    expect(choose).toBeDefined();
    choose?.('DARK');
    await flush();

    // On screen, and in the store. In that order: a person who changes the theme and loses the
    // write still gets the theme they asked for, which is the right way round.
    expect(readProbe(rendered)).toBe('DARK');
    expect(written.get('appearance')).toBe('DARK');
  });

  it('reports the platform reduce-motion setting', async () => {
    setReduceMotion(true);
    const { preferences } = storeHolding();
    const rendered = renderScreen(
      <LocalStoreProvider value={storeValue(preferences)}>
        <ThemeProvider>
          <Probe />
        </ThemeProvider>
      </LocalStoreProvider>,
    );
    await flush();
    expect(readProbe(rendered)).toContain('|true');
  });

  it('hands out the frozen theme objects rather than copies of them', async () => {
    // Identity matters: `useThemedStyles` memoises on it, so a theme rebuilt per render would
    // recreate every screen's styles on every frame with nothing to say so.
    const seen: unknown[] = [];
    function Capture() {
      seen.push(useTheme());
      return null;
    }
    setColorScheme('dark');
    const { preferences } = storeHolding();
    renderScreen(
      <LocalStoreProvider value={storeValue(preferences)}>
        <ThemeProvider>
          <Capture />
        </ThemeProvider>
      </LocalStoreProvider>,
    );
    await flush();
    expect(seen[0]).toBe(DARK_THEME);
    expect(seen.every((theme) => theme === DARK_THEME || theme === LIGHT_THEME)).toBe(true);
  });
});
