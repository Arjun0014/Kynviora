/**
 * What the screen tells the agent about itself, and how it says it.
 *
 * Spec references: `17`, `15` (a model's output is validated against what is actually available),
 * `16` (data minimisation), DEC-132 (the agent gets tools and never data), DEC-157.
 *
 * WHY A PROVIDER AND NOT A PROP
 * The Talk bar is drawn by the navigator, above every destination, and the screen inside the
 * navigator is the thing that knows what it can do. Threading a context up through the navigator
 * would mean every screen knowing about the bar; a provider means the bar reads one value and each
 * screen writes its own.
 *
 * WHAT A SCREEN MAY DECLARE
 * A route, a profile id, an id for whatever is focused, a count of what is selected, and a small
 * set of **named actions with handlers**. Nothing else. `ScreenContext` has no field content could
 * arrive in and this provider adds none: the handlers stay here, on the phone, and only their
 * names and labels ever reach the snapshot.
 *
 * WHY THE HANDLERS ARE HELD SEPARATELY FROM THE SNAPSHOT
 * So that the object the panel footer renders is the same object a request would carry. A
 * `ScreenContext` carrying functions could not honestly be shown as "the whole of what was sent",
 * and the temptation to serialise it and hope would arrive the first time somebody wired a
 * provider.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  emptyScreenContext,
  resolveScreenAction,
  type AgentRoute,
  type ScreenAction,
  type ScreenContext,
} from '@kynviora/agent';

/** One thing a screen can do, with the function that does it. */
export interface ScreenActionBinding extends ScreenAction {
  readonly run: () => void;
}

/** What a screen declares. The snapshot is derived from it; the handlers never leave. */
export interface ScreenDeclaration {
  readonly route: AgentRoute;
  readonly profileId?: string | null;
  readonly focusId?: string | null;
  readonly selectedCount?: number;
  readonly actions?: readonly ScreenActionBinding[];
  /**
   * Whether the space belongs to a task rather than to the bar.
   *
   * The three the design language names - camera capture, an open sheet, selection mode - plus a
   * critical confirmation. A screen sets whichever applies and the bar disappears.
   */
  readonly capturing?: boolean;
  readonly sheetOpen?: boolean;
  readonly selecting?: boolean;
  readonly confirming?: boolean;
}

export interface ScreenContextValue {
  /** Exactly what would be sent. No functions, no content. */
  readonly snapshot: ScreenContext;
  readonly capturing: boolean;
  readonly sheetOpen: boolean;
  readonly selecting: boolean;
  readonly confirming: boolean;
  /**
   * Run a named action, if this screen offers it.
   *
   * Returns the action that ran, or `null` where the name was not one on offer - which is the
   * caller's cue to say it could not do that rather than to do nothing.
   */
  readonly runAction: (actionId: string) => ScreenAction | null;
  /** Declare this screen. Call from an effect; the last caller wins. */
  readonly declare: (declaration: ScreenDeclaration) => void;
  readonly clear: (route: AgentRoute) => void;
}

const EMPTY: ScreenContextValue = {
  snapshot: emptyScreenContext(),
  capturing: false,
  sheetOpen: false,
  selecting: false,
  confirming: false,
  runAction: () => null,
  declare: () => undefined,
  clear: () => undefined,
};

const Context = createContext<ScreenContextValue>(EMPTY);

export function ScreenContextProvider({ children }: { readonly children: ReactNode }) {
  const [declaration, setDeclaration] = useState<ScreenDeclaration | null>(null);
  // The handlers, kept out of state so running one does not depend on a render having happened.
  const handlersRef = useRef<readonly ScreenActionBinding[]>([]);

  const declare = useCallback((next: ScreenDeclaration) => {
    handlersRef.current = next.actions ?? [];
    setDeclaration(next);
  }, []);

  const clear = useCallback((route: AgentRoute) => {
    // Only the screen that declared may clear. Without the check, a screen unmounting *after* the
    // next one has declared wipes the new screen's context - which is the ordinary order in a
    // navigator, and would leave the bar offering nothing exactly when it should offer most.
    setDeclaration((current) => (current === null || current.route === route ? null : current));
    handlersRef.current = [];
  }, []);

  const snapshot = useMemo<ScreenContext>(() => {
    if (declaration === null) return emptyScreenContext();
    return {
      route: declaration.route,
      profileId: declaration.profileId ?? null,
      focusId: declaration.focusId ?? null,
      selectedCount: declaration.selectedCount ?? 0,
      // Names and labels only. The handlers stay in the ref.
      actions: (declaration.actions ?? []).map(({ id, label, says }) => ({ id, label, says })),
    };
  }, [declaration]);

  const runAction = useCallback(
    (actionId: string) => {
      // Validated against the snapshot, which is the same list the agent was offered - so a name
      // that was never on offer is refused before any handler is reached (`15`, DEC-147).
      const declared = resolveScreenAction(snapshot, actionId);
      if (declared === null) return null;
      const binding = handlersRef.current.find((action) => action.id === actionId);
      if (binding === undefined) return null;
      binding.run();
      return declared;
    },
    [snapshot],
  );

  const value = useMemo<ScreenContextValue>(
    () => ({
      snapshot,
      capturing: declaration?.capturing ?? false,
      sheetOpen: declaration?.sheetOpen ?? false,
      selecting: declaration?.selecting ?? false,
      confirming: declaration?.confirming ?? false,
      runAction,
      declare,
      clear,
    }),
    [snapshot, declaration, runAction, declare, clear],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useScreenContext(): ScreenContextValue {
  return useContext(Context);
}

/**
 * Declare this screen's context for as long as it is mounted.
 *
 * `declaration` must be memoised by the caller, or this re-declares on every render - which is
 * the `exhaustive-deps` failure mode `DEV-044` and `DEV-045` were, arriving through a hook that
 * looks convenient.
 */
export function useDeclareScreen(declaration: ScreenDeclaration): void {
  const { declare, clear } = useScreenContext();
  const route = declaration.route;
  useEffect(() => {
    declare(declaration);
    return () => {
      clear(route);
    };
  }, [declare, clear, declaration, route]);
}
