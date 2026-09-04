import { describe, it, expect } from 'vitest';
import { CONSENT_COPY } from '@kynviora/presentation';
import { consentView, type ConsentView } from '@kynviora/contracts';
import { ApiProvider } from '@/api/ApiProvider';
import { hasName, press, renderScreen, screenNames } from '../../../test/render.js';
import { ConsentSettings } from './ConsentSettings';

/**
 * The consent screen's export and deletion sections.
 *
 * Spec references: `16` (a person can get a copy of what is held about them; the export shows what
 * is included), `04` Phase 1.4, `12` (nothing claimed before the server answers), DEC-117,
 * `DEV-036`.
 *
 * WHY THIS FILE EXISTS
 * `DEV-036`'s argument was that a settings row which opens nothing is worse than no row, because
 * it tells somebody a control exists. Half of that is now resolved and half is not, and the
 * screen has to say which is which. Three things could go wrong and none is visible from the
 * types:
 *
 *  - the copy could claim to be ready before the server answered (`12`);
 *  - an incomplete copy could be reported as a complete one, which is the single failure this
 *    feature cannot have - a missing section looks exactly like a section that was empty;
 *  - the deletion sentence could drift into "not built yet" over both halves, which is now false
 *    in the other direction and sends somebody looking for a control they have walked past.
 */

const EMPTY_VIEW: ConsentView = consentView({
  consents: [],
  policyVersion: 'v1',
  serverTime: '2026-09-05T12:00:00.000Z',
});

type Overrides = Partial<Parameters<typeof ConsentSettings>[0]> & {
  /**
   * Withhold the export callback entirely.
   *
   * A separate flag rather than `onExport: undefined`, because `exactOptionalPropertyTypes` makes
   * those two different things - and the distinction is the one under test: an absent callback is
   * a control that is not offered, not one that is offered and does nothing.
   */
  readonly withoutExport?: boolean;
};

function screen(overrides: Overrides = {}) {
  const calls: string[] = [];
  const { withoutExport, ...props } = overrides;
  const rendered = renderScreen(
    <ApiProvider
      value={{
        client: null,
        session: { kind: 'ANONYMOUS' },
        configurationError: null,
        elevate: () => null,
      }}
    >
      <ConsentSettings
        view={EMPTY_VIEW}
        onChanged={() => calls.push('changed')}
        {...(withoutExport === true ? {} : { onExport: () => calls.push('export') })}
        {...props}
      />
    </ApiProvider>,
  );
  return { rendered, calls };
}

const joined = (r: ReturnType<typeof screen>['rendered']) => screenNames(r).join(' | ');

describe('the export section', () => {
  it('says what the copy contains and what it leaves out, before the control', () => {
    // `16` asks the export to show what will be included, and a person checks a copy once - so
    // the omissions belong on this screen rather than inside the file they have already saved.
    const text = joined(screen().rendered);
    expect(text).toContain(CONSENT_COPY.exportHeading);
    expect(text).toContain(CONSENT_COPY.exportIntro);
    expect(text).toContain(CONSENT_COPY.exportOmissionsNote);
  });

  it('offers the control, and says step-up will be asked for', () => {
    const { rendered } = screen();
    expect(hasName(rendered, CONSENT_COPY.exportLabel)).toBe(true);
  });

  it('withholds the control where no copy can be taken', () => {
    // Absent rather than disabled (DEC-045). The section still explains what a copy would be, so
    // the person is not left wondering whether the feature exists.
    const { rendered } = screen({ withoutExport: true });
    expect(hasName(rendered, CONSENT_COPY.exportLabel)).toBe(false);
    expect(joined(rendered)).toContain(CONSENT_COPY.exportHeading);
  });

  it('claims nothing before the server has answered', () => {
    // `12`. The press reports the intent; the caller performs the request and passes the result
    // back. A screen that said "ready" on the press would name a file nobody has.
    const { rendered, calls } = screen();
    press(rendered, CONSENT_COPY.exportLabel);
    expect(calls).toEqual(['export']);
    expect(joined(rendered)).not.toContain(CONSENT_COPY.exportReadyNote);
  });

  it('says the copy is ready only when told', () => {
    const { rendered } = screen({ exportReady: true });
    expect(joined(rendered)).toContain(CONSENT_COPY.exportReadyNote);
  });

  it('reports an incomplete copy instead of a ready one', () => {
    // The failure this whole feature exists to avoid. A section the server could not assemble
    // comes back as a count of `-1`, and reporting that run as "ready" would hand somebody a file
    // with a hole in it and tell them it was their record.
    const { rendered } = screen({ exportReady: true, exportIncomplete: true });
    const text = joined(rendered);
    expect(text).toContain(CONSENT_COPY.exportIncompleteNote);
    expect(text).not.toContain(CONSENT_COPY.exportReadyNote);
  });

  it('renders a refusal as a state and keeps the control', () => {
    // Unlike a deletion, an export is worth retrying: nothing has changed, and the reason may be
    // a step-up that can be completed.
    const { rendered } = screen({
      exportState: 'STEP_UP_REQUIRED',
      exportMessage: null,
    });
    expect(hasName(rendered, CONSENT_COPY.exportLabel)).toBe(true);
  });
});

describe('the deletion section', () => {
  it('says account deletion is not built and points at the deletion that is', () => {
    // "Not built yet" over both halves would now be false. Item deletion exists and lives on the
    // item screen, and a person who reads this row is exactly the person looking for it.
    const text = joined(screen().rendered);
    expect(text).toContain(CONSENT_COPY.deletionHeading);
    expect(text).toContain(CONSENT_COPY.deletionNote);
  });

  it('offers no control, because there is nothing behind one', () => {
    // `DEV-036`'s original argument, still true for this half.
    const names = screenNames(screen().rendered);
    expect(names.some((name) => /remove|delete/i.test(name) && name.length < 40)).toBe(false);
  });
});
