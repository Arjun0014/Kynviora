/**
 * `expo-router`, for a test.
 *
 * The navigators draw their children and nothing else. What a test asks of a screen is what the
 * screen drew, not where the router put it - and a real navigator would need a route tree, which
 * is `expo-router`'s behaviour rather than this app's.
 */
import { createElement, type ReactNode } from 'react';

function passthrough(name: string) {
  const Component = ({ children }: { readonly children?: ReactNode }) =>
    createElement(name, null, children);
  Component.displayName = name;
  return Component;
}

const Screen = passthrough('RouterScreen');
export const Stack = Object.assign(passthrough('Stack'), { Screen });
export const Tabs = Object.assign(passthrough('Tabs'), { Screen });
export const Slot = passthrough('Slot');
export const useRouter = () => ({ push: () => undefined, back: () => undefined });
export const useLocalSearchParams = () => ({});
