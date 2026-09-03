/**
 * The Visit Pack judgements, run with nothing attached (DEC-102).
 *
 * The one worth reading is `PACK-3`. An export is the only thing in this app that leaves it
 * entirely, and the failure that matters is not a missing item but an extra one.
 */

import { describe, expect, it } from 'vitest';
import {
  candidatesCheck,
  exportContentCheck,
  exportCreatedCheck,
  exportExpiryCheck,
  exportReadableCheck,
  textOf,
  type ServerPack,
} from './visitPackExport.js';

const CHOSEN = 'Synthetic Tablet A';
const LEFT_OUT = 'Synthetic Capsule B';

function pack(overrides: Partial<ServerPack> = {}): ServerPack {
  return {
    id: '00000000-0000-4000-8000-0000000000e1',
    generatedAt: '2026-09-04T09:00:00.000Z',
    expiresAt: '2026-09-11T09:00:00.000Z',
    entries: [{ label: 'Current medicines', lines: [`${CHOSEN}, 500 mg, tablet`] }],
    ...overrides,
  };
}

describe('textOf', () => {
  it('reads a name wherever in the entry it was written', () => {
    expect(textOf({ label: 'Current medicines', lines: ['Synthetic Tablet A'] })).toContain(
      'Synthetic Tablet A',
    );
    expect(textOf({ lines: [] })).toBe('');
  });
});

describe('PACK-0, the control', () => {
  it('is inconclusive when there is nothing to leave out', () => {
    // Without something deliberately excluded, a pack containing everything passes every other
    // check here.
    const check = candidatesCheck({ offered: [CHOSEN], chosen: CHOSEN, leftOut: LEFT_OUT });
    expect(check.status).toBe('INCONCLUSIVE');
    expect(check.detail).toContain('and nothing else');
  });

  it('is inconclusive when the screen could not be read', () => {
    expect(candidatesCheck({ offered: null, chosen: CHOSEN, leftOut: LEFT_OUT }).status).toBe(
      'INCONCLUSIVE',
    );
  });

  it('passes when both are on offer', () => {
    expect(
      candidatesCheck({
        offered: [`${CHOSEN}, 500 mg`, `${LEFT_OUT}, 20 mg`],
        chosen: CHOSEN,
        leftOut: LEFT_OUT,
      }).status,
    ).toBe('PASS');
  });
});

describe('PACK-1, one export', () => {
  const steps: readonly (readonly [string, boolean])[] = [['open the flow', true]];

  it('names the step that did not happen', () => {
    const check = exportCreatedCheck({
      steps: [
        ['open the flow', true],
        ['reach the review step', false],
      ],
      creates: [],
    });
    expect(check.status).toBe('INCONCLUSIVE');
    expect(check.detail).toContain('reach the review step');
  });

  it('fails when nothing was created', () => {
    expect(exportCreatedCheck({ steps, creates: [] }).status).toBe('FAIL');
  });

  it('fails on two exports where one was asked for', () => {
    const check = exportCreatedCheck({
      steps,
      creates: [
        { status: 201, key: 'a' },
        { status: 201, key: 'b' },
      ],
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('own expiry');
  });

  it('fails when the create carried no idempotency key', () => {
    const check = exportCreatedCheck({ steps, creates: [{ status: 201, key: null }] });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('a retry would make a second one');
  });

  it('passes on one create with a key', () => {
    expect(exportCreatedCheck({ steps, creates: [{ status: 201, key: 'a' }] }).status).toBe('PASS');
  });
});

describe('PACK-2, reading it back', () => {
  it('fails when the create named no export', () => {
    const check = exportReadableCheck({ packId: null, readable: false });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('nothing the person could hand to anybody');
  });

  it('fails when the named export cannot be read by its owner', () => {
    const check = exportReadableCheck({ packId: 'x', readable: false });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('at the appointment');
  });

  it('passes when the create named an export the owner can read', () => {
    expect(exportReadableCheck({ packId: 'x', readable: true }).status).toBe('PASS');
  });
});

describe('PACK-3, what is in it', () => {
  it('fails when the export holds something nobody ticked', () => {
    // The failure that cannot be taken back: the copy has already been handed over.
    const check = exportContentCheck({
      pack: pack({
        entries: [
          { label: 'Current medicines', lines: [`${CHOSEN}, 500 mg`, `${LEFT_OUT}, 20 mg`] },
        ],
      }),
      chosen: CHOSEN,
      leftOut: LEFT_OUT,
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('nobody ticked');
  });

  it('fails when the export is missing what was ticked', () => {
    const check = exportContentCheck({
      pack: pack({ entries: [] }),
      chosen: CHOSEN,
      leftOut: LEFT_OUT,
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('believing it is complete');
  });

  it('passes on exactly the one that was ticked', () => {
    expect(exportContentCheck({ pack: pack(), chosen: CHOSEN, leftOut: LEFT_OUT }).status).toBe(
      'PASS',
    );
  });
});

describe('PACK-4, the expiry', () => {
  it('fails when the export never expires', () => {
    const check = exportExpiryCheck(pack({ expiresAt: null }));
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('kept for ever');
  });

  it('fails when the expiry is not after the moment it was made', () => {
    expect(exportExpiryCheck(pack({ expiresAt: '2026-09-04T08:00:00.000Z' })).status).toBe('FAIL');
  });

  it('passes and says how long it lasts', () => {
    const check = exportExpiryCheck(pack());
    expect(check.status).toBe('PASS');
    expect(check.detail).toContain('7 day(s)');
  });
});
