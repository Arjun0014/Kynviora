/** `react-native-safe-area-context`, for a test. Insets are a layout fact, and layout is the device's. */
import { createElement, type ReactNode } from 'react';

function passthrough(name: string) {
  const Component = ({ children }: { readonly children?: ReactNode }) =>
    createElement(name, null, children);
  Component.displayName = name;
  return Component;
}

export const SafeAreaProvider = passthrough('SafeAreaProvider');
export const SafeAreaView = passthrough('SafeAreaView');
export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });
