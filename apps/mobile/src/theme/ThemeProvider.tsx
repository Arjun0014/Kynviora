/**
 * Which of the two themes this app is wearing, and how a component gets it.
 *
 * Spec references: `18` (appearance and motion are accessibility settings, not decoration; system
 * font scaling; meaning never carried by colour alone), `12` (platform behaviour behind an
 * adapter), DEC-130.
 *
 * THREE STATES, NOT TWO
 * `FOLLOW_SYSTEM` is the default and is a different thing from having chosen the theme the system
 * currently is. Somebody following the system in September is still following it in October when
 * their phone switches itself at dusk; somebody who chose light is not. Collapsing the two at
 * storage time would silently un-follow anybody who opened the setting and closed it again.
 *
 * WHY THE RESOLVED THEME IS A CONTEXT AND NOT AN IMPORT
 * A `StyleSheet.create` at module scope captures the colours it was given at import time, so a
 * screen that imports a palette directly can never change theme without the app restarting. Every
 * screen therefore builds its styles from {@link useThemedStyles}, which is the same
 * `StyleSheet.create` behind a memo keyed on the theme.
 *
 * WHAT REDUCE-MOTION IS DOING HERE
 * It rides with the theme because it is the same kind of thing - a system-level preference every
 * component has to respect and none of them should be reading the platform for. `motionDuration`
 * in the tokens is the only place a duration is chosen, and this is where it gets its answer.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AccessibilityInfo, useColorScheme } from 'react-native';
import { DARK_THEME, LIGHT_THEME, type Theme, type ThemeName } from '@kynviora/presentation';
import { useLocalStore } from '@/storage/LocalStoreProvider';

/** What a person may choose, as opposed to what is then resolved. */
export const APPEARANCE_CHOICES = ['FOLLOW_SYSTEM', 'LIGHT', 'DARK'] as const;
export type AppearanceChoice = (typeof APPEARANCE_CHOICES)[number];

export function isAppearanceChoice(value: unknown): value is AppearanceChoice {
  return typeof value === 'string' && (APPEARANCE_CHOICES as readonly string[]).includes(value);
}

/**
 * Resolve a choice and what the system is currently doing into one of the two themes.
 *
 * A system that reports nothing resolves to light. Not because light is better, but because
 * `null` from `useColorScheme` means "this platform did not say", and the darker of two answers
 * is the one that changes more about a screen - so the quieter guess is the safer one.
 */
export function resolveThemeName(
  choice: AppearanceChoice,
  // React Native's own `ColorSchemeName`, which has a third member: `unspecified`. Taken as it
  // comes rather than narrowed at the call site, so a platform that says "I have no idea" is a
  // case this function has an answer for rather than one that fails to compile.
  system: 'light' | 'dark' | 'unspecified' | null | undefined,
): ThemeName {
  if (choice === 'LIGHT') return 'LIGHT';
  if (choice === 'DARK') return 'DARK';
  return system === 'dark' ? 'DARK' : 'LIGHT';
}

export interface ThemeContextValue {
  readonly theme: Theme;
  /** What the person chose, which is not always what is being rendered. */
  readonly choice: AppearanceChoice;
  /** Whether the stored choice has been read yet. Before that, the system's answer is used. */
  readonly settled: boolean;
  readonly setChoice: (choice: AppearanceChoice) => void;
  /**
   * Whether the platform reports a reduce-motion preference.
   *
   * Read once and then on change. Every animated component asks this rather than the platform, so
   * honouring it is one decision instead of one per screen.
   */
  readonly reduceMotion: boolean;
}

const DEFAULT: ThemeContextValue = {
  theme: LIGHT_THEME,
  choice: 'FOLLOW_SYSTEM',
  settled: false,
  setChoice: () => undefined,
  reduceMotion: false,
};

const ThemeContext = createContext<ThemeContextValue>(DEFAULT);

export interface ThemeProviderProps {
  readonly children: ReactNode;
  /** Injected by tests, which have no platform appearance and no encrypted store. */
  readonly value?: Partial<ThemeContextValue>;
}

export function ThemeProvider({ children, value }: ThemeProviderProps) {
  const system = useColorScheme();
  const { preferences, settled: storeSettled } = useLocalStore();

  const [choice, setStoredChoice] = useState<AppearanceChoice>('FOLLOW_SYSTEM');
  const [settled, setSettled] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  // Read the stored choice once the store is open. A store that never opens leaves the default,
  // which is the same state as a fresh install - and the app is fully usable in it.
  useEffect(() => {
    if (value !== undefined) return;
    if (!storeSettled) return;
    if (preferences === null) {
      setSettled(true);
      return;
    }
    let live = true;
    void preferences.read('appearance').then(
      (stored) => {
        if (!live) return;
        if (isAppearanceChoice(stored)) setStoredChoice(stored);
        setSettled(true);
      },
      () => {
        if (!live) return;
        setSettled(true);
      },
    );
    return () => {
      live = false;
    };
  }, [preferences, storeSettled, value]);

  useEffect(() => {
    if (value !== undefined) return;
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(
      (enabled) => {
        if (live) setReduceMotion(enabled);
      },
      () => undefined,
    );
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (enabled: boolean) => {
        if (live) setReduceMotion(enabled);
      },
    );
    return () => {
      live = false;
      subscription.remove();
    };
  }, [value]);

  const setChoice = useCallback(
    (next: AppearanceChoice) => {
      // On screen first, stored second. A person who changes the theme and loses the write still
      // gets the theme they asked for for this session, which is the right way round: the
      // alternative is a control that appears not to work.
      setStoredChoice(next);
      void preferences?.write('appearance', next).catch(() => undefined);
    },
    [preferences],
  );

  const resolved = useMemo<ThemeContextValue>(() => {
    const name = resolveThemeName(choice, system);
    return {
      theme: name === 'DARK' ? DARK_THEME : LIGHT_THEME,
      choice,
      settled,
      setChoice,
      reduceMotion,
      ...value,
    };
  }, [choice, system, settled, setChoice, reduceMotion, value]);

  return <ThemeContext.Provider value={resolved}>{children}</ThemeContext.Provider>;
}

export function useThemeContext(): ThemeContextValue {
  return useContext(ThemeContext);
}

/** The theme itself, which is what almost every component wants. */
export function useTheme(): Theme {
  return useContext(ThemeContext).theme;
}

/**
 * Build a screen's styles from the current theme, rebuilt only when the theme changes.
 *
 * The replacement for a module-scope `StyleSheet.create`, which captures its colours at import
 * time and can therefore never change theme. `make` is expected to be a module-scope function so
 * its identity is stable; the memo is keyed on the theme rather than on `make` for that reason,
 * and a `make` defined inside a component would still work, just without the memo helping.
 */
export function useThemedStyles<T>(make: (theme: Theme) => T): T {
  const theme = useTheme();
  return useMemo(() => make(theme), [theme, make]);
}
