/**
 * Rendering a screen, and asking it the questions the device harness asks.
 *
 * Spec references: `18` (every control carries a name a screen reader can announce), `19`,
 * DEC-102.
 *
 * WHY THE QUERIES LOOK LIKE `scripts/device/ui.ts`
 * Deliberately. `nodeNamed` on a device finds a node by its **accessible name** - `content-desc`
 * where there is one, the rendered text otherwise - because that is what a screen reader
 * announces and therefore what `18` makes the app responsible for. `findByName` here resolves the
 * same thing off the rendered tree. A check that passes in CI and a check that passes on a phone
 * are then asking one question rather than two that happen to agree, and a control that loses its
 * label fails in both places.
 *
 * WHAT `act` IS FOR
 * Effects. Several of the defects worth covering are in `useEffect` and in callbacks whose
 * dependencies moved (`DEV-044`, `DEV-045`, `DEV-053`, trap 174), and none of them is reachable
 * from a render that never flushes. Every helper here runs inside `act`, and `flush` exists for
 * the case where an effect awaited a promise.
 */

import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import type { ReactElement } from 'react';

export interface Rendered {
  readonly renderer: ReactTestRenderer;
  /** Re-render with a different element, inside `act`. */
  readonly update: (element: ReactElement) => void;
  readonly unmount: () => void;
}

export function renderScreen(element: ReactElement): Rendered {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return {
    renderer,
    update: (next) => {
      act(() => {
        renderer.update(next);
      });
    },
    unmount: () => {
      act(() => {
        renderer.unmount();
      });
    },
  };
}

/**
 * Let every already-resolved promise settle, then flush the effects that follow.
 *
 * A provider that opens a store or a screen that loads a resource does its work in an async
 * effect, so the first paint is the loading state and the interesting one is two microtask turns
 * later. Awaiting nothing in particular is the honest way to say "after the work that was already
 * queued".
 */
export async function flush(times = 3): Promise<void> {
  for (let turn = 0; turn < times; turn += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/**
 * The name a screen reader would announce for a node.
 *
 * `accessibilityLabel` where there is one, otherwise the node's own rendered text - which is
 * exactly `accessibleNameOf`'s rule in `scripts/device/accessibility.ts`, because Android reports
 * `content-desc` in preference to `text` and falls back the same way.
 */
export function accessibleNameOf(node: ReactTestInstance): string {
  const label = node.props['accessibilityLabel'];
  if (typeof label === 'string' && label.trim() !== '') return label.trim();
  return textOf(node);
}

/** Every string rendered under a node, joined - the node's own visible text. */
export function textOf(node: ReactTestInstance | ReactElement): string {
  const collected: string[] = [];
  const walk = (child: unknown): void => {
    if (typeof child === 'string') {
      collected.push(child);
      return;
    }
    if (typeof child === 'number') {
      collected.push(String(child));
      return;
    }
    if (Array.isArray(child)) {
      for (const entry of child) walk(entry);
      return;
    }
    if (child !== null && typeof child === 'object' && 'children' in (child as ReactTestInstance)) {
      walk((child as ReactTestInstance).children);
    }
  };
  walk((node as ReactTestInstance).children);
  return collected.join('').trim();
}

export type NameMatch = string | { readonly startsWith: string } | { readonly contains: string };

export function nameMatches(actual: string, wanted: NameMatch): boolean {
  if (typeof wanted === 'string') return actual === wanted;
  if ('startsWith' in wanted) return actual.startsWith(wanted.startsWith);
  return actual.includes(wanted.contains);
}

/**
 * Every **rendered** node in the tree, in draw order.
 *
 * Host elements only - `View`, `Text`, `Pressable` and the rest of the stub - never the
 * components that produced them. `react-test-renderer` puts a composite instance in the tree
 * beside each host one, carrying the same props: `<PrimaryButton label="Shelf" onPress={...} />`
 * is a node whose accessible name is "Shelf" and which has an `onPress`, sitting directly above
 * the `Pressable` that is also both of those things. Counting it would make every control appear
 * twice.
 *
 * It is also the wrong thing to count on its own terms. `uiautomator` reports a hierarchy of
 * views; a React component is not a view and has no counterpart on a device. Filtering to host
 * elements is what makes "the control named X" mean the same thing in this file and in
 * `scripts/device/ui.ts`.
 */
export function allNodes(rendered: Rendered): readonly ReactTestInstance[] {
  const root = rendered.renderer.root;
  return root.findAll((node) => typeof node.type === 'string', { deep: true });
}

/**
 * Every node whose accessible name matches, in draw order.
 *
 * Plural on purpose. A list draws one identically-named control per row - trap 192 is a whole
 * device harness learning that the hard way - so a test that means "there is exactly one" should
 * say so rather than take the first and hope.
 */
export function findAllByName(rendered: Rendered, wanted: NameMatch): readonly ReactTestInstance[] {
  return allNodes(rendered).filter((node) => nameMatches(accessibleNameOf(node), wanted));
}

/**
 * Whether a node is something a person can act on.
 *
 * `nodeNamed` on a device asks the same thing as `node.clickable`, and Android reports an
 * `EditText` as clickable too - so a field and a button both qualify and a label does not.
 */
function isInteractive(node: ReactTestInstance): boolean {
  return (
    typeof node.props['onPress'] === 'function' || typeof node.props['onChangeText'] === 'function'
  );
}

/**
 * The node with this accessible name that a person would act on.
 *
 * A control and its own label carry the same accessible name by construction: `PrimaryButton`
 * puts the label on the `Pressable` as `accessibilityLabel` and renders it again as the `Text`
 * inside. Two matches, one control. `nodeNamed` resolves this on a device by preferring a
 * clickable node, and this does the same - which is why the two agree about what "the control
 * named X" means rather than agreeing by luck.
 *
 * `null` where nothing matches, and where two *interactive* nodes do: a list drawing one
 * identically-named control per row is trap 192, and a query that silently took the first is how
 * a run measures the wrong row while reporting the right name.
 */
export function findByName(rendered: Rendered, wanted: NameMatch): ReactTestInstance | null {
  const found = findAllByName(rendered, wanted);
  const interactive = found.filter(isInteractive);
  if (interactive.length > 1) return null;
  if (interactive.length === 1) return interactive[0] ?? null;
  return found.length === 1 ? (found[0] ?? null) : null;
}

/** Whether any node carries this accessible name. The absence half of DEC-045. */
export function hasName(rendered: Rendered, wanted: NameMatch): boolean {
  return findAllByName(rendered, wanted).length > 0;
}

/** Every accessible name on screen, deduplicated, in draw order - the screen as a reader hears it. */
export function screenNames(rendered: Rendered): readonly string[] {
  const seen = new Set<string>();
  for (const node of allNodes(rendered)) {
    const name = accessibleNameOf(node);
    if (name !== '') seen.add(name);
  }
  return [...seen];
}

/**
 * Press the one control with this name.
 *
 * Throws rather than returning false where there is not exactly one, because a test that pressed
 * nothing and carried on measures the state it started in - which is trap 195's shape, and it has
 * cost two device runs already.
 */
export function press(rendered: Rendered, wanted: NameMatch): void {
  const node = findByName(rendered, wanted);
  if (node === null) {
    const count = findAllByName(rendered, wanted).filter(isInteractive).length;
    throw new Error(
      `Expected exactly one control named ${JSON.stringify(wanted)}, found ${String(count)}. ` +
        `On screen: ${JSON.stringify(screenNames(rendered))}`,
    );
  }
  const onPress = node.props['onPress'];
  if (typeof onPress !== 'function') {
    throw new Error(`The node named ${JSON.stringify(wanted)} has no onPress.`);
  }
  act(() => {
    (onPress as () => void)();
  });
}

/** Type into the one text field with this name, as `onChangeText` receives it. */
export function typeInto(rendered: Rendered, wanted: NameMatch, value: string): void {
  const node = findByName(rendered, wanted);
  if (node === null) {
    throw new Error(
      `Expected exactly one field named ${JSON.stringify(wanted)}. ` +
        `On screen: ${JSON.stringify(screenNames(rendered))}`,
    );
  }
  const onChangeText = node.props['onChangeText'];
  if (typeof onChangeText !== 'function') {
    throw new Error(`The node named ${JSON.stringify(wanted)} has no onChangeText.`);
  }
  act(() => {
    (onChangeText as (next: string) => void)(value);
  });
}
