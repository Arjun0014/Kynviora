import { describe, it, expect } from 'vitest';
import { ITEM_DELETION_COPY } from '@kynviora/presentation';
import { findByName, hasName, press, renderScreen, screenNames } from '../../../test/render.js';
import { DeleteItem } from './DeleteItem';

/**
 * The confirmation screen for deleting an item.
 *
 * Spec references: `16` (the workflow enumerates what goes and what is retained; do not claim
 * universal erasure while retained records have a lifecycle), `18` (confirm a destructive action;
 * one idea per sentence), `12` (no optimistic change), `04` Phase 2.1 (medicines and personal-care
 * items coexist without either being reduced to a generic note), DEC-117.
 *
 * WHAT IS WORTH TESTING HERE
 * Three things, and none is visible from the types.
 *
 * The first is `16`'s hardest sentence: that the screen says what is **kept**. It is the one line
 * a product is most tempted to leave out, it is the one that makes the rest honest, and nothing
 * but a test over the rendered tree can tell whether it survived an edit.
 *
 * The second is that the two item kinds get different lists. A shampoo has no doses, and a screen
 * offering to remove a dose history that never existed describes something that was never there.
 *
 * The third is that nothing is claimed before the server answers (`12`). The confirm control must
 * not put the screen into its "Deleted" state by itself.
 */

function screen(overrides: Partial<Parameters<typeof DeleteItem>[0]> = {}) {
  const calls: string[] = [];
  const rendered = renderScreen(
    <DeleteItem
      displayName="Synthetic Tablet A"
      itemKind="MEDICINE"
      onConfirm={() => calls.push('confirm')}
      onCancel={() => calls.push('cancel')}
      {...overrides}
    />,
  );
  return { rendered, calls };
}

const joined = (r: ReturnType<typeof screen>['rendered']) => screenNames(r).join(' | ');

describe('what the screen says before anything happens', () => {
  it('names the item and what deleting it removes', () => {
    const { rendered } = screen();
    const text = joined(rendered);

    expect(text).toContain('Synthetic Tablet A');
    expect(text).toContain(ITEM_DELETION_COPY.goesHeading);
    for (const line of ITEM_DELETION_COPY.medicineGoes) {
      expect(text).toContain(line);
    }
  });

  it('says what is kept, and why', () => {
    // `16` forbids claiming immediate universal erasure while retained records have a specified
    // lifecycle, and `audit_event` is retained 24 months (DEC-117). This is the sentence that
    // makes the rest of the screen true; a version of this component without it would pass every
    // other test in this file.
    const { rendered } = screen();
    expect(joined(rendered)).toContain(ITEM_DELETION_COPY.staysHeading);
    expect(joined(rendered)).toContain(ITEM_DELETION_COPY.staysNote);
  });

  it('says the deletion reaches caregivers too', () => {
    // The shelf is shared and the screen does not look shared. Somebody deleting a medicine is
    // entitled to know that the person they gave access to will stop seeing it.
    expect(joined(screen().rendered)).toContain(ITEM_DELETION_COPY.caregiverNote);
  });

  it('says it cannot be undone, and that identity will be confirmed first', () => {
    const text = joined(screen().rendered);
    expect(text).toContain(ITEM_DELETION_COPY.noUndo);
    // `14`. Said before the button, so nobody presses it expecting to be finished.
    expect(text).toContain(ITEM_DELETION_COPY.stepUpPrompt);
  });

  it('offers the archive alternative when the caller can reach it', () => {
    // `DEV-032` was archiving offered where deletion belonged. With both present the risk runs the
    // other way: deletion is the control that sounds final, so somebody who wants Kynviora to stop
    // asking about a finished course reaches for it.
    const withArchive = screen({ onArchiveInstead: () => undefined });
    expect(joined(withArchive.rendered)).toContain(ITEM_DELETION_COPY.archiveAlternative);

    // Absent rather than disabled where there is nothing to open (DEC-045).
    expect(joined(screen().rendered)).not.toContain(ITEM_DELETION_COPY.archiveAlternative);
  });
});

describe('a personal-care product is not described as a medicine', () => {
  it('lists what it actually has, and no doses', () => {
    const { rendered } = screen({ itemKind: 'PERSONAL_CARE', displayName: 'Synthetic Shampoo' });
    const text = joined(rendered);

    expect(text).toContain(ITEM_DELETION_COPY.personalCareHeading);
    for (const line of ITEM_DELETION_COPY.personalCareGoes) {
      expect(text).toContain(line);
    }
    // The specific failure this guards: a shared list would promise to remove a dose history that
    // never existed, which `04` Phase 2.1 calls reducing one kind to the other's terms.
    expect(text).not.toContain('dose');
    expect(text).not.toContain('reminder');
    expect(text).not.toContain(ITEM_DELETION_COPY.medicineHeading);
  });
});

describe('every control has a name a screen reader can announce', () => {
  it('carries both buttons, labelled', () => {
    const { rendered } = screen();
    expect(hasName(rendered, ITEM_DELETION_COPY.confirmLabel)).toBe(true);
    expect(hasName(rendered, ITEM_DELETION_COPY.cancelLabel)).toBe(true);
  });

  it('gives the confirm control a hint that says what it does', () => {
    // `18`: a destructive control's name is the shortest thing on the screen, and the hint is
    // where the consequence goes for somebody who never sees the paragraphs.
    const { rendered } = screen();
    const confirm = findByName(rendered, ITEM_DELETION_COPY.confirmLabel);
    expect(confirm?.props['accessibilityHint']).toBe(ITEM_DELETION_COPY.noUndo);
  });
});

describe('nothing is claimed before the server answers', () => {
  it('reports the confirmation and does not change its own state', () => {
    // `12`: a screen that showed "Deleted" on the press would be a false statement about
    // somebody's health record, in the direction that reassures. The caller performs the request
    // and passes `deleted` back.
    const { rendered, calls } = screen();
    press(rendered, ITEM_DELETION_COPY.confirmLabel);

    expect(calls).toEqual(['confirm']);
    expect(joined(rendered)).not.toContain(ITEM_DELETION_COPY.doneHeading);
    expect(hasName(rendered, ITEM_DELETION_COPY.confirmLabel)).toBe(true);
  });

  it('shows the done state only when told', () => {
    const { rendered } = screen({ deleted: true });
    const text = joined(rendered);
    expect(text).toContain(ITEM_DELETION_COPY.doneHeading);
    expect(text).toContain(ITEM_DELETION_COPY.doneNote);
    // And the confirm control is gone, so a second press cannot happen from this screen.
    expect(hasName(rendered, ITEM_DELETION_COPY.confirmLabel)).toBe(false);
  });
});

describe('a refusal', () => {
  it('renders the server’s own message and withdraws the control', () => {
    // Never a reason invented here. `13` does not let the API distinguish a refusal from an
    // absence, so the client genuinely does not know which happened - and a screen that guessed
    // would be inventing the more alarming of the two.
    const { rendered } = screen({
      state: 'RECOVERABLE_ERROR',
      stateMessage: 'Not found.',
    });
    expect(joined(rendered)).toContain('Not found.');
    expect(hasName(rendered, ITEM_DELETION_COPY.confirmLabel)).toBe(false);
    expect(hasName(rendered, ITEM_DELETION_COPY.cancelLabel)).toBe(true);
  });

  it('renders a step-up refusal the same way, as a state rather than as an excuse', () => {
    const { rendered } = screen({
      state: 'RECOVERABLE_ERROR',
      stateMessage: 'This action requires you to confirm your identity again.',
    });
    expect(joined(rendered)).toContain('confirm your identity again');
    expect(hasName(rendered, ITEM_DELETION_COPY.confirmLabel)).toBe(false);
  });
});
