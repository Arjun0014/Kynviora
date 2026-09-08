import { describe, expect, it } from 'vitest';
import {
  AGENT_ROUTES,
  describeScreenContext,
  emptyScreenContext,
  isAgentRoute,
  resolveScreenAction,
  screenPhrasings,
  type ScreenAction,
  type ScreenContext,
} from './screenContext.js';

const ACTIONS: readonly ScreenAction[] = [
  { id: 'filter.oral', label: 'Show only toothpaste', says: 'Showing toothpaste only.' },
  { id: 'filter.clear', label: 'Show everything', says: 'Showing everything on the shelf.' },
];

function context(over: Partial<ScreenContext> = {}): ScreenContext {
  return {
    route: 'SHELF',
    profileId: 'profile-1',
    focusId: null,
    selectedCount: 0,
    actions: ACTIONS,
    ...over,
  };
}

describe('what the snapshot may contain', () => {
  it('has no field that could carry content', () => {
    // DEC-132's rule, enforced by the shape rather than by a comment. `title`, `displayName`,
    // `text`, `name`, `value` are the fields a medicine name or a lab value would arrive in. If
    // somebody adds one, this fails and says why.
    const keys = Object.keys(context());
    for (const forbidden of ['title', 'displayName', 'text', 'name', 'value', 'items', 'content']) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
    expect([...keys].sort()).toEqual(['actions', 'focusId', 'profileId', 'route', 'selectedCount']);
  });

  it('counts what is selected rather than listing it', () => {
    // A list of identifiers is still a list, and a snapshot that grew one would be a channel for
    // "which seven things is this person looking at".
    expect(typeof context({ selectedCount: 7 }).selectedCount).toBe('number');
  });

  it('narrows a route from outside the closed set', () => {
    expect(isAgentRoute('SHELF')).toBe(true);
    expect(isAgentRoute('__proto__')).toBe(false);
    expect(isAgentRoute(null)).toBe(false);
    expect(AGENT_ROUTES).toContain('UNKNOWN');
  });

  it('starts empty rather than guessing where it is', () => {
    const empty = emptyScreenContext();
    expect(empty.route).toBe('UNKNOWN');
    expect(empty.actions).toEqual([]);
  });
});

describe('describeScreenContext', () => {
  it('renders every field of the snapshot, so the footer’s claim is true', () => {
    // The design language: the footer shows "the exact context snapshot that left the phone -
    // route, profile, what is focused, what is selected - because that is the whole of what was
    // sent". That sentence is only honest if this function omits nothing, so the test walks the
    // object's own keys rather than checking a fixed list.
    const snapshot = context({ focusId: 'item-9', selectedCount: 3 });
    const described = describeScreenContext(snapshot);
    for (const key of Object.keys(snapshot)) {
      expect(described.toLowerCase(), key).toContain(
        key === 'selectedCount' ? 'selected' : key.replace('Id', '').toLowerCase(),
      );
    }
  });

  it('says what a missing value is rather than leaving a gap', () => {
    const described = describeScreenContext(emptyScreenContext());
    expect(described).toContain('profile none');
    expect(described).toContain('focused nothing');
    expect(described).toContain('selected 0');
  });

  it('carries the identifier and not a name, because that is all there is', () => {
    expect(describeScreenContext(context({ focusId: 'item-9' }))).toContain('item-9');
  });
});

describe('resolveScreenAction', () => {
  it('finds an action the screen actually offers', () => {
    expect(resolveScreenAction(context(), 'filter.oral')?.says).toBe('Showing toothpaste only.');
  });

  it('refuses one the screen did not offer', () => {
    // `15`: what a model produced is validated against what is actually available, every time.
    expect(resolveScreenAction(context(), 'delete.everything')).toBeNull();
  });

  it('refuses a name that would otherwise resolve through the prototype', () => {
    // DEC-147, at the place it matters most: a proposed action id resolving to `Object.prototype`
    // would be a function the screen never declared, reached by a string a model produced.
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(resolveScreenAction(context(), name), name).toBeNull();
    }
  });

  it('refuses everything on a screen that offers nothing', () => {
    expect(resolveScreenAction(context({ actions: [] }), 'filter.oral')).toBeNull();
  });
});

describe('screenPhrasings', () => {
  it('offers the labels the screen declared, in its own order', () => {
    expect(screenPhrasings(context())).toEqual(['Show only toothpaste', 'Show everything']);
  });

  it('offers nothing on a screen that declared nothing', () => {
    // An honest empty state rather than a bug: a screen with no contextual actions has none, and
    // the panel says so.
    expect(screenPhrasings(emptyScreenContext())).toEqual([]);
  });
});
