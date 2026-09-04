import { describe, it, expect } from 'vitest';
import {
  PRODUCT_BARCODE_SYMBOLOGIES,
  cameraPermissionState,
  judgeScan,
  mayOpenCamera,
  mayRequestCameraAgain,
} from './barcodeScan.js';

/**
 * What a scanned barcode is, and what it is not.
 *
 * Spec references: `04` Phase 2.2, `08` (three separate verification axes), `09` (unconfirmed
 * machine output never becomes trusted truth), `16` (permission requested by a visible feature),
 * `17`, `BLK-003`.
 */

/** A real-shaped GTIN-13 with a correct check digit, computed by hand. */
const VALID_EAN13 = '5012345678900';
/** The same digits with the check digit changed. */
const BAD_CHECK_EAN13 = '5012345678901';

describe('judging a camera read', () => {
  it('accepts a well-formed product barcode', () => {
    const outcome = judgeScan({ symbology: 'ean13', data: VALID_EAN13 });
    expect(outcome).toEqual({ kind: 'ACCEPTED', gtin: VALID_EAN13, symbology: 'ean13' });
  });

  it('accepts every symbology the app asks the camera for, and no others', () => {
    // Narrow on purpose. A QR code on a pack is a marketing URL far more often than a product
    // identifier, and reading one into the GTIN field would put a web address where a number goes.
    expect([...PRODUCT_BARCODE_SYMBOLOGIES]).toEqual(['ean13', 'ean8', 'upc_a', 'upc_e']);

    const qr = judgeScan({ symbology: 'qr', data: 'https://example.test/promo' });
    expect(qr).toEqual({ kind: 'REJECTED', reason: 'NOT_A_PRODUCT_BARCODE' });

    const code128 = judgeScan({ symbology: 'code128', data: VALID_EAN13 });
    expect(code128).toEqual({ kind: 'REJECTED', reason: 'NOT_A_PRODUCT_BARCODE' });
  });

  it('rejects a misread whose check digit does not agree', () => {
    // The reason this arithmetic is worth doing at all: a misread symbol produces digits that look
    // exactly like a real barcode, and a wrong GTIN silently attached to somebody's medicine is
    // worse than no GTIN - it is a claim about which product this is.
    expect(judgeScan({ symbology: 'ean13', data: BAD_CHECK_EAN13 })).toEqual({
      kind: 'REJECTED',
      reason: 'CHECK_DIGIT_FAILED',
    });
  });

  it('rejects anything that is not digits of a GTIN length', () => {
    for (const data of ['', '123', 'ABCDEFGHIJKLM', '50123456789000000', '501234-678900']) {
      expect(judgeScan({ symbology: 'ean13', data })).toEqual({
        kind: 'REJECTED',
        reason: 'NOT_A_GTIN_SHAPE',
      });
    }
  });

  it('trims surrounding whitespace and nothing else', () => {
    expect(judgeScan({ symbology: 'ean13', data: `  ${VALID_EAN13} ` })).toMatchObject({
      kind: 'ACCEPTED',
      gtin: VALID_EAN13,
    });
    // Internal separators are not stripped. A barcode with a space in it was not read correctly,
    // and repairing it here would be the app deciding what the label said.
    expect(judgeScan({ symbology: 'ean13', data: '501234 5678900' })).toMatchObject({
      kind: 'REJECTED',
    });
  });

  it('never returns anything about the product', () => {
    // `08` and `BLK-003`. The outcome carries digits and a symbology. There is deliberately no
    // field for a name, a formulation, or a verification state: a scan is a faster way to type,
    // and a shape that could carry a product would invite a later change that resolved one.
    const outcome = judgeScan({ symbology: 'ean13', data: VALID_EAN13 });
    expect(Object.keys(outcome).sort()).toEqual(['gtin', 'kind', 'symbology']);
  });
});

describe('the camera permission state', () => {
  it('reads an unasked permission as undetermined', () => {
    expect(cameraPermissionState(null)).toBe('UNDETERMINED');
    expect(
      cameraPermissionState({ granted: false, canAskAgain: true, status: 'undetermined' }),
    ).toBe('UNDETERMINED');
  });

  it('separates a refusal that can be asked again from one that cannot', () => {
    // The distinction a naive model loses, and the one that decides which control the screen
    // offers. Telling somebody who chose "don't ask again" to allow camera access sends them to
    // press a button that will never appear.
    expect(cameraPermissionState({ granted: false, canAskAgain: true, status: 'denied' })).toBe(
      'DENIED',
    );
    expect(cameraPermissionState({ granted: false, canAskAgain: false, status: 'denied' })).toBe(
      'BLOCKED',
    );
  });

  it('opens the camera only when granted', () => {
    expect(mayOpenCamera('GRANTED')).toBe(true);
    for (const state of ['UNDETERMINED', 'DENIED', 'BLOCKED'] as const) {
      expect(mayOpenCamera(state)).toBe(false);
    }
  });

  it('offers to ask again only where asking can succeed', () => {
    expect(mayRequestCameraAgain('UNDETERMINED')).toBe(true);
    expect(mayRequestCameraAgain('DENIED')).toBe(true);
    expect(mayRequestCameraAgain('BLOCKED')).toBe(false);
    // Already granted: there is nothing to ask for, and a request control here would be a second
    // prompt for something the person has already agreed to.
    expect(mayRequestCameraAgain('GRANTED')).toBe(false);
  });
});
