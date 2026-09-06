/**
 * What `react-native` is, for a test.
 *
 * Spec references: `12` (the client is a device), `19` (automated coverage), `DEV-043`, DEC-112.
 *
 * WHY A STUB AND NOT THE REAL THING
 * Not a preference. React Native's source ships as Flow-annotated JavaScript - `View.js` opens
 * with `@flow strict-local` - which Vitest's esbuild transform cannot parse at all, and the parts
 * that do parse expect a native bridge that does not exist in Node. Every project that tests React
 * Native components under a non-Metro runner substitutes the module; the honest thing is to say so
 * rather than to imply the real renderer ran.
 *
 * WHAT THIS THEREFORE DOES AND DOES NOT TEST
 * It tests **what the app decides to draw**: which controls exist, what accessible name each
 * carries, what a press does, and how a component reacts to a prop or a hook's state changing.
 * That is where every defect the device runs have found actually lived - a control drawn when it
 * should have been withheld (`RECORD_DOSES`), a callback holding a stale dependency (`DEV-044`,
 * `DEV-053`), a fallback that turned a loaded value into `false` (`DEV-045`).
 *
 * It tests **nothing about layout**. Whether a control is 48dp, whether it is clipped at 2x font
 * scale, whether a sheet can be scrolled to - none of that is here, because none of it is decided
 * by this code. `verify:device:a11y` measures those against a real layout engine and remains the
 * only thing that can.
 *
 * The third gate is the one that keeps this stub honest: `npm run typecheck:mobile` compiles the
 * app against the **real** React Native types. A prop this stub would happily accept and React
 * Native does not is still a compile error, so the stub can be permissive without the app becoming
 * so.
 *
 * HOST COMPONENTS RENDER AS THEMSELVES
 * `View` renders as the host element `"View"`, `Text` as `"Text"`, and so on, with every prop
 * passed through untouched. A test therefore reads `accessibilityLabel` and `accessibilityRole`
 * off the tree exactly as `uiautomator` reads `content-desc` and the class off a real hierarchy,
 * which is what lets `findByName` here ask the same question `nodeNamed` asks there.
 */

import { createElement, type ReactNode } from 'react';

type AnyProps = Record<string, unknown>;

function host(name: string) {
  const Component = (props: AnyProps) => createElement(name, props);
  Component.displayName = name;
  return Component;
}

export const View = host('View');
export const Text = host('Text');
export const TextInput = host('TextInput');
export const ScrollView = host('ScrollView');
export const ActivityIndicator = host('ActivityIndicator');
export const RefreshControl = host('RefreshControl');

/**
 * `Pressable`, including the two shapes React Native gives it.
 *
 * `style` may be a function of the press state and so may `children`; `PrimaryButton` uses the
 * first. Both are resolved with `pressed: false`, because a test that wanted the pressed
 * appearance would be testing a style rather than a decision.
 */
export const Pressable = (props: AnyProps) => {
  const { style, children, ...rest } = props;
  const resolvedStyle =
    typeof style === 'function' ? (style as (s: unknown) => unknown)({ pressed: false }) : style;
  const resolvedChildren =
    typeof children === 'function'
      ? (children as (s: unknown) => ReactNode)({ pressed: false })
      : (children as ReactNode);
  return createElement('Pressable', { ...rest, style: resolvedStyle }, resolvedChildren);
};
Pressable.displayName = 'Pressable';

export const StyleSheet = {
  /** Identity. Style objects are not what any of these tests are about. */
  create: <T extends Record<string, unknown>>(styles: T): T => styles,
  flatten: (style: unknown): unknown =>
    Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style,
  absoluteFill: {},
  hairlineWidth: 1,
};

export const Platform = {
  OS: 'android' as const,
  select: <T,>(options: { android?: T; ios?: T; default?: T }): T | undefined =>
    options.android ?? options.default,
};

// ---------------------------------------------------------------------------
// The two pieces of ambient device state a test needs to move
// ---------------------------------------------------------------------------

interface Dimensions {
  width: number;
  height: number;
  scale: number;
  fontScale: number;
}

const dimensions: Dimensions = { width: 412, height: 915, scale: 2.625, fontScale: 1 };

/**
 * Set the window metrics the next render will see.
 *
 * `fontScale` is the one that matters: `PrimaryButton`, `StatusChip` and the tab bar all read it,
 * and `18`'s font-scaling requirements are the reason they do. A test can therefore ask what a
 * component decides at 2x - which is a different question from whether the result is clipped, and
 * the only half of it that lives in this code.
 */
export function setWindowDimensions(next: Partial<Dimensions>): void {
  Object.assign(dimensions, next);
}

export function resetWindowDimensions(): void {
  Object.assign(dimensions, { width: 412, height: 915, scale: 2.625, fontScale: 1 });
}

export function useWindowDimensions(): Dimensions {
  return { ...dimensions };
}

type AppStateStatusValue = 'active' | 'background' | 'inactive';
type AppStateListener = (status: AppStateStatusValue) => void;

const appStateListeners = new Set<AppStateListener>();

export const AppState = {
  currentState: 'active' as AppStateStatusValue,
  addEventListener(event: string, listener: AppStateListener) {
    if (event === 'change') appStateListeners.add(listener);
    return {
      remove: () => {
        appStateListeners.delete(listener);
      },
    };
  },
};

/**
 * Fire an app-state change at every listener.
 *
 * `PendingSyncProvider` re-drains the queue when the app returns to `active`, which is the
 * behaviour trap 174 says a test can accidentally rely on: pressing HOME and returning repairs
 * state that a cold launch got wrong, so a check that backgrounds the app before measuring reports
 * a working engine over a broken one. Being able to fire this deliberately is what lets a test
 * measure the cold-launch pass **without** it.
 */
export function emitAppState(status: AppStateStatusValue): void {
  AppState.currentState = status;
  for (const listener of [...appStateListeners]) listener(status);
}

export function resetAppState(): void {
  appStateListeners.clear();
  AppState.currentState = 'active';
}

/**
 * The system share sheet.
 *
 * A stub, and a loud one: it records what it was asked to share and resolves. What it **cannot**
 * substitute is whether Android actually offers a target, whether the receiving app can take a
 * payload of this size, and what the person does next - all of which are the interesting half of
 * handing somebody a copy of their own health record, and none of which exists in Node.
 *
 * So a test here can measure that the copy reaching the sheet is the copy the server sent, and
 * cannot measure that it arrived anywhere. That is a device question (`19`).
 */
const sharedPayloads: { title?: string; message: string }[] = [];

export const Share = {
  share(content: { title?: string; message: string }) {
    sharedPayloads.push(content);
    return Promise.resolve({ action: 'sharedAction' as const });
  },
};

export function sharedContent(): readonly { title?: string; message: string }[] {
  return sharedPayloads;
}

export function resetShare(): void {
  sharedPayloads.length = 0;
}

export type AppStateStatus = AppStateStatusValue;
export type ViewStyle = Record<string, unknown>;
export type TextStyle = Record<string, unknown>;
export type ColorValue = string;

// ---------------------------------------------------------------------------
// Appearance and reduce-motion
// ---------------------------------------------------------------------------

/**
 * What the platform says the colour scheme is.
 *
 * A stub of a **setting**, not of rendering: it can answer "the phone is in dark mode", and it
 * establishes nothing about whether the resulting screen is legible. That is a contrast question,
 * which the token tests answer arithmetically, and a layout question, which only a device can.
 */
type ColorScheme = 'light' | 'dark' | null;
let colorScheme: ColorScheme = 'light';

export function setColorScheme(next: ColorScheme): void {
  colorScheme = next;
}

export function resetColorScheme(): void {
  colorScheme = 'light';
}

export function useColorScheme(): ColorScheme {
  return colorScheme;
}

type ReduceMotionListener = (enabled: boolean) => void;
const reduceMotionListeners = new Set<ReduceMotionListener>();
let reduceMotionEnabled = false;

export function setReduceMotion(enabled: boolean): void {
  reduceMotionEnabled = enabled;
  for (const listener of reduceMotionListeners) listener(enabled);
}

export function resetReduceMotion(): void {
  reduceMotionEnabled = false;
  reduceMotionListeners.clear();
}

export const AccessibilityInfo = {
  isReduceMotionEnabled(): Promise<boolean> {
    return Promise.resolve(reduceMotionEnabled);
  },
  addEventListener(event: string, listener: ReduceMotionListener) {
    if (event === 'reduceMotionChanged') reduceMotionListeners.add(listener);
    return {
      remove: () => {
        reduceMotionListeners.delete(listener);
      },
    };
  },
};

export type ColorSchemeName = ColorScheme | 'unspecified';
