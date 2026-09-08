/**
 * Where the one primary action on Care sits, relative to everything that grows without bound.
 *
 * Spec references: `18` (a critical action stays reachable at every supported font scale), `06`
 * Journey 6, DEC-159, `DEV-099`, `DEV-100`.
 *
 * WHY THE ASSERTION IS ABOUT ORDER AND NOT ABOUT PRESENCE
 * `Invite someone` was never missing. It was drawn after every row the access list holds -
 * including access that has **ended** - and on the development profile, which carries seven
 * revoked grants, at font scale 2 that put it thousands of pixels below the fold. A test asking
 * "is there a control named Invite someone" passed the whole time (`DEV-099` fixed the same
 * failure in the other component and this one kept it).
 *
 * So the property is positional: nothing whose length depends on how many people have *ever* had
 * access may be drawn above it. `allNodes` returns the tree in draw order, which is the same order
 * a person scrolls through, so an index comparison is the honest form of that question in Node.
 *
 * It cannot replace the device measurement and does not try to: pixels are what `18` is about and
 * this file has none. What it does is fail in CI if the control is moved back below the history.
 */

import { describe, it, expect } from 'vitest';
import { CAPABILITY_DESCRIPTIONS } from '@kynviora/presentation';
import type { CaregiverAccessRowView } from '@kynviora/contracts';
import { CareCircle } from './CareCircle';
import { CaregiverAccessList } from './CaregiverAccessList';
import { allNodes, accessibleNameOf, renderScreen } from '../../../test/render.js';

/** One live grant, so the circle has a card in it. */
const ACTIVE: CaregiverAccessRowView = {
  id: 'grant-active',
  subject: 'GRANT',
  state: 'ACTIVE',
  capabilities: ['VIEW_SHELF'],
  displayName: 'Anita',
  expiresAt: null,
  isSelf: false,
};

/** Seven revoked grants: exactly what the development profile carries (`DEV-099`). */
const ENDED: readonly CaregiverAccessRowView[] = Array.from({ length: 7 }, (_, index) => ({
  id: `grant-ended-${String(index)}`,
  subject: 'GRANT' as const,
  state: 'REVOKED' as const,
  capabilities: ['VIEW_SHELF' as const, 'VIEW_MEDICINES' as const],
  displayName: `Removed ${String(index)}`,
  expiresAt: null,
  isSelf: false,
}));

const ROWS: readonly CaregiverAccessRowView[] = [ACTIVE, ...ENDED];

/**
 * The two components in the order `care.tsx` draws them.
 *
 * Composed here rather than importing the route, because `src/app` is Expo Router's directory and
 * a test that pulled a route in would pull its providers with it (`DEV-054` is the neighbouring
 * hazard). What is being measured is the composition, so the composition is what is written out -
 * and it is written out identically, which is the thing a reader has to check.
 */
function renderCare(onInvite: (() => void) | null) {
  return renderScreen(
    <>
      <CareCircle rows={ROWS} now={Date.parse('2026-09-09T00:00:00Z')} onInvite={onInvite} />
      <CaregiverAccessList state="READY" rows={ROWS} onRevoke={() => undefined} />
    </>,
  );
}

function indexOfName(rendered: ReturnType<typeof renderCare>, name: string): number {
  return allNodes(rendered).findIndex((node) => accessibleNameOf(node) === name);
}

/**
 * How many controls a person could press carry this name.
 *
 * The interactive ones only. `PrimaryButton` puts the label on the `Pressable` and renders it
 * again as the `Text` inside, so every button matches twice by name and once by name and press -
 * and "how many controls are there" is the question this file is asking.
 */
function pressableCount(rendered: ReturnType<typeof renderCare>, name: string): number {
  return allNodes(rendered).filter(
    (node) => accessibleNameOf(node) === name && typeof node.props['onPress'] === 'function',
  ).length;
}

describe('Care: where Invite someone sits', () => {
  it('draws Invite someone before any row for access that has ended', () => {
    const rendered = renderCare(() => undefined);

    const invite = indexOfName(rendered, 'Invite someone');
    expect(invite).toBeGreaterThanOrEqual(0);

    // The first ended row, by the name only an ended row carries. Not by index into `ROWS`: the
    // question is where the *drawn* thing is, and a row that stopped rendering would otherwise
    // make this pass.
    const firstEnded = allNodes(rendered).findIndex(
      (node) => accessibleNameOf(node) === 'Removed 0',
    );
    expect(firstEnded).toBeGreaterThanOrEqual(0);
    expect(invite).toBeLessThan(firstEnded);
  });

  it('draws Invite someone before the sentence that counts ended access', () => {
    const rendered = renderCare(() => undefined);
    const invite = indexOfName(rendered, 'Invite someone');
    const counted = allNodes(rendered).findIndex((node) =>
      accessibleNameOf(node).startsWith('7 people no longer have access'),
    );
    expect(counted).toBeGreaterThanOrEqual(0);
    expect(invite).toBeLessThan(counted);
  });

  it('offers exactly one Invite someone, so neither component draws a second', () => {
    const rendered = renderCare(() => undefined);
    expect(pressableCount(rendered, 'Invite someone')).toBe(1);
  });

  it('offers none at all where this account may delegate nothing (DEC-045)', () => {
    const rendered = renderCare(null);
    expect(pressableCount(rendered, 'Invite someone')).toBe(0);
  });
});

/**
 * What a card about access that has ended says about it.
 *
 * `DEV-101`: this screen used to draw "What they can see" and the present-tense sentence under it
 * directly beneath a chip reading "Access removed. It stopped straight away." The rule is measured
 * on the **rendered screen** and not only on `accessCoverage`, because the defect was a screen
 * calling the wrong function - the package was right the whole time.
 *
 * Each state is rendered on its own, rather than reading the composed screen: both rows are drawn
 * by one component, so an assertion over the whole screen cannot tell the live row's sentences
 * from the ended row's.
 */
describe('Care: what an ended row claims', () => {
  const CAPABILITIES = ['VIEW_MEDICINES', 'MANAGE_SHELF'] as const;

  function renderOne(state: CaregiverAccessRowView['state']) {
    return renderScreen(
      <CaregiverAccessList
        state="READY"
        rows={[
          {
            id: 'row',
            subject: 'GRANT',
            state,
            capabilities: [...CAPABILITIES],
            displayName: 'Anita',
            expiresAt: null,
            isSelf: false,
          },
        ]}
        onRevoke={() => undefined}
      />,
    );
  }

  function screenText(rendered: ReturnType<typeof renderOne>): string {
    return allNodes(rendered)
      .map((node) => accessibleNameOf(node))
      .join(' ~ ');
  }

  it('does not say a revoked grant can see anything', () => {
    const screen = screenText(renderOne('REVOKED'));
    expect(screen).toContain('Access removed');
    // The sentence itself, not a paraphrase: the point is that this exact string was on screen
    // under that chip.
    expect(screen).not.toContain(CAPABILITY_DESCRIPTIONS.VIEW_MEDICINES.meaning);
    expect(screen).not.toContain(CAPABILITY_DESCRIPTIONS.MANAGE_SHELF.meaning);
    expect(screen).not.toContain('What they can see');
    // On ended access everything is withheld, so a list of a subset says nothing. The limitation
    // is carried by the status, which is on screen.
    expect(screen).not.toContain('Not shared with them');
    expect(screen).toContain('You removed their access');
  });

  it('says what the ended access let them do, in labels', () => {
    const screen = screenText(renderOne('REVOKED'));
    expect(screen).toContain('What it let them see');
    expect(screen).toContain(CAPABILITY_DESCRIPTIONS.VIEW_MEDICINES.label);
    expect(screen).toContain('What it let them change');
    expect(screen).toContain(CAPABILITY_DESCRIPTIONS.MANAGE_SHELF.label);
  });

  it('still states a live grant in the present tense', () => {
    // A fix that silenced the ended rows by silencing every row would pass everything above.
    const screen = screenText(renderOne('ACTIVE'));
    expect(screen).toContain('What they can see');
    expect(screen).toContain(CAPABILITY_DESCRIPTIONS.VIEW_MEDICINES.meaning);
    expect(screen).toContain('Not shared with them');
  });
});
