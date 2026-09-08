import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_CENTER_INTRO,
  IRREVERSIBLE_ROW_NOTE,
  SETTINGS_GROUPS,
  isSettingsGroup,
  settingsGroupPresentation,
  settingsGroupRows,
  type SettingsGroup,
} from './settingsGroups.js';
import { ICON_NAMES } from './status.js';

describe('the eight groups', () => {
  it('gives each one a name, a sentence and a shape', () => {
    for (const group of SETTINGS_GROUPS) {
      const p = settingsGroupPresentation(group);
      expect(p.title.length, group).toBeGreaterThan(0);
      expect(p.summary.length, group).toBeGreaterThan(0);
      expect(ICON_NAMES as readonly string[], group).toContain(p.iconName);
    }
  });

  it('names the contents rather than repeating the category', () => {
    // "Manage your account" tells nobody whether to open it. The summary has to say what is
    // inside, which is the difference between a row somebody can decide about and a label.
    for (const group of SETTINGS_GROUPS) {
      const p = settingsGroupPresentation(group);
      expect(p.summary.toLowerCase(), group).not.toBe(p.title.toLowerCase());
      expect(p.summary.toLowerCase(), group).not.toMatch(/^manage /);
    }
  });

  it('ends every summary as a sentence', () => {
    // `18`: familiar words first, one idea per line. A row summary that trails off is one that
    // was written as a label and is being read as a sentence.
    for (const group of SETTINGS_GROUPS) {
      expect(settingsGroupPresentation(group).summary, group).toMatch(/\.$/);
    }
  });

  it('puts the account first and help last', () => {
    // The order is part of the design and not alphabetical: "which account am I in" is what makes
    // every other row mean something, and help is where somebody goes when the rest did not work.
    expect(SETTINGS_GROUPS[0]).toBe('ACCOUNT');
    expect(SETTINGS_GROUPS[SETTINGS_GROUPS.length - 1]).toBe('HELP');
  });

  it('keeps appearance and accessibility above anything that needs a network answer', () => {
    // A person on a phone that cannot reach the server should still be able to make the screen
    // readable (`18`, DEC-130). Connections and the agent both need the server.
    const order = [...SETTINGS_GROUPS];
    expect(order.indexOf('ACCESSIBILITY')).toBeLessThan(order.indexOf('CONNECTIONS'));
    expect(order.indexOf('APPEARANCE')).toBeLessThan(order.indexOf('AGENT'));
  });

  it('marks exactly one group as containing something irreversible', () => {
    const irreversible = SETTINGS_GROUPS.filter(
      (group) => settingsGroupPresentation(group).containsIrreversible,
    );
    expect(irreversible).toEqual(['ACCOUNT']);
  });

  it('says so in a word, and does not encode it anywhere else', () => {
    // `18` forbids meaning by colour alone and `02` forbids alarm. A row painted red because
    // deletion is somewhere inside it would be both, so the fact lives in a sentence.
    expect(IRREVERSIBLE_ROW_NOTE).toMatch(/cannot be undone/i);
    const account = settingsGroupPresentation('ACCOUNT');
    expect(account.summary).toContain('closing your account');
    expect(Object.keys(account).sort()).toEqual([
      'containsIrreversible',
      'group',
      'iconName',
      'summary',
      'title',
    ]);
  });

  it('offers the rows in the declared order and nothing else', () => {
    expect(settingsGroupRows().map((row) => row.group)).toEqual([...SETTINGS_GROUPS]);
  });

  it('narrows a stored value from outside the set', () => {
    expect(isSettingsGroup('ACCOUNT')).toBe(true);
    expect(isSettingsGroup('constructor')).toBe(false);
    expect(isSettingsGroup(null)).toBe(false);
  });

  it('falls back to the account group for a value from outside it', () => {
    // DEC-147.
    const rogue = settingsGroupPresentation('__proto__' as SettingsGroup);
    expect(rogue.group).toBe('ACCOUNT');
    expect(typeof rogue.title).toBe('string');
  });
});

describe('the Account Center', () => {
  it('says where closing an account is, so it is findable without being first', () => {
    // `16` requires the control to exist and be findable. V3 moves it off the home screen and
    // asks for it to be "deep enough that it is intentional but still discoverable" - which is
    // only true if something on the way in says where it is.
    expect(ACCOUNT_CENTER_INTRO).toMatch(/closing an account/i);
    expect(ACCOUNT_CENTER_INTRO).toMatch(/bottom of this page/i);
  });

  it('does not describe closing an account as anything softer than it is', () => {
    // Not "remove", not "deactivate", not "leave". `18`: a control says what it does.
    expect(ACCOUNT_CENTER_INTRO.toLowerCase()).not.toMatch(/deactivate|remove your account/);
  });
});
