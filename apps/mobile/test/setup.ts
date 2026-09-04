/**
 * What the runtime has to be told before any of these tests render anything.
 *
 * Three things, and each is about being able to trust what a test saw.
 *
 * `IS_REACT_ACT_ENVIRONMENT` is React's own switch for "updates outside `act` are a mistake worth
 * warning about". Without it React declines to batch inside `act` and prints "The current testing
 * environment is not configured to support act(...)" - and, more to the point, an effect that
 * should have run before an assertion may not have. The tests that matter most here are about
 * effects and about callbacks whose dependencies moved, so a renderer that quietly skipped one
 * would report the defect as absent.
 *
 * `__DEV__` is a global React Native defines and Node does not. Anything from the Expo or React
 * Native runtime that this tree pulls in reads it at module scope, so its absence is an
 * import-time crash rather than a behaviour difference. `true` is what a development build has,
 * which is the build every device harness drives.
 *
 * Both are assigned through a cast rather than declared, because React Native's own types already
 * declare `__DEV__` as a `const` - redeclaring it is an error, and assigning to
 * `globalThis.__DEV__` is not the same name as far as the compiler is concerned.
 *
 * The deprecation notice is silenced, and only that one. `react-test-renderer` prints it on every
 * import; React 19 still ships and supports it, and the alternative for a React Native tree is a
 * DOM testing library rendering components that have no DOM. One line per test is noise that hides
 * real stderr, which is the actual cost - so the filter names the exact string and passes
 * everything else through, because a warning nobody reads is the same as no warning at all.
 */

const globals = globalThis as unknown as Record<string, unknown>;

globals['IS_REACT_ACT_ENVIRONMENT'] = true;
globals['__DEV__'] = true;

const DEPRECATION = 'react-test-renderer is deprecated';
const originalError = console.error.bind(console);

console.error = (...args: readonly unknown[]): void => {
  const first = args[0];
  if (typeof first === 'string' && first.includes(DEPRECATION)) return;
  originalError(...args);
};

export {};
