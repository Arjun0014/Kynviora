import { describe, it, expect } from 'vitest';
import { parseGtin, computeCheckDigit, sameTradeItem } from './gtin.js';
import { unwrap, isErr, isOk } from '@kynviora/domain';

describe('computeCheckDigit', () => {
  it('computes known GS1 check digits', () => {
    // Well-known published examples across symbologies.
    expect(computeCheckDigit('123456789012')).toBe(8); // EAN-13 body
    expect(computeCheckDigit('03600029145')).toBe(2); // UPC-A body
    expect(computeCheckDigit('978030640615')).toBe(7); // ISBN-13 as EAN-13
  });

  it('alternates weights from the rightmost body digit', () => {
    // Keying weights off absolute position instead of distance-from-right silently breaks when
    // the same routine is reused across GTIN-8/12/13/14, so this pins the direction.
    expect(computeCheckDigit('0000000')).toBe(0);
    expect(computeCheckDigit('0000001')).toBe(7); // 1*3 = 3 -> (10-3)%10 = 7
    expect(computeCheckDigit('0000010')).toBe(9); // 1*1 = 1 -> (10-1)%10 = 9
  });
});

describe('parseGtin', () => {
  it('accepts a valid EAN-13', () => {
    const info = unwrap(parseGtin('9780306406157'));
    expect(info.symbology).toBe('EAN-13');
    expect(info.length).toBe(13);
    expect(info.gtin14).toBe('09780306406157');
  });

  it('accepts a valid UPC-A', () => {
    const info = unwrap(parseGtin('036000291452'));
    expect(info.symbology).toBe('UPC-A');
    expect(info.gtin14).toBe('00036000291452');
  });

  it('accepts a valid GTIN-8', () => {
    const body = '9638507';
    const gtin8 = body + String(computeCheckDigit(body));
    const info = unwrap(parseGtin(gtin8));
    expect(info.symbology).toBe('GTIN-8');
    expect(info.gtin14).toBe(gtin8.padStart(14, '0'));
  });

  it('strips separators people type or scanners emit', () => {
    const info = unwrap(parseGtin(' 978-0306-406157 '));
    expect(info.normalized).toBe('9780306406157');
  });

  it('rejects a bad check digit', () => {
    // Spec 04 Phase 3.1: "Invalid scans cannot create trusted item records."
    const result = parseGtin('9780306406158');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('INVALID_BARCODE');
      expect(result.error.detail?.reason_code).toBe('check_digit_mismatch');
    }
  });

  it('rejects an unsupported length', () => {
    const result = parseGtin('12345');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.detail?.reason_code).toBe('unsupported_length');
  });

  it('rejects non-numeric input', () => {
    const result = parseGtin('97803064O6157'); // letter O instead of zero
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.detail?.reason_code).toBe('non_numeric');
  });

  it('rejects empty input', () => {
    expect(isErr(parseGtin(''))).toBe(true);
    expect(isErr(parseGtin('   '))).toBe(true);
  });

  it('never leaks the barcode value into the error detail', () => {
    // Spec 14 constrains error detail to non-sensitive scalars.
    const result = parseGtin('9780306406158');
    if (isErr(result)) {
      expect(JSON.stringify(result.error)).not.toContain('9780306406158');
    }
  });
});

describe('sameTradeItem', () => {
  it('matches a UPC-A against its EAN-13 representation', () => {
    // The same trade item is frequently encoded in both symbologies; comparison happens in
    // GTIN-14 space so they unify.
    const upc = unwrap(parseGtin('036000291452'));
    const ean = unwrap(parseGtin('0036000291452'));
    expect(sameTradeItem(upc, ean)).toBe(true);
  });

  it('does not match different trade items', () => {
    const a = unwrap(parseGtin('036000291452'));
    const b = unwrap(parseGtin('9780306406157'));
    expect(sameTradeItem(a, b)).toBe(false);
  });

  it('answers trade-item identity only, never formulation identity', () => {
    // Spec 08: "Never treat barcode as proof of formula, batch, expiry, or current label."
    // Two observations of the same GTIN can carry entirely different formulations; that case is
    // handled by resolveFormulationObservation, which is what creates a conflict.
    const first = unwrap(parseGtin('036000291452'));
    const second = unwrap(parseGtin('036000291452'));
    expect(sameTradeItem(first, second)).toBe(true);
    // The function exposes nothing about formulation - it returns a boolean about identifiers.
    expect(isOk(parseGtin('036000291452'))).toBe(true);
  });
});
