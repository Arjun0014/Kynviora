/**
 * What a scanned barcode is, and what it is not (`04` Phase 2.2, `08`, `09`, `17`).
 *
 * Spec references: `04` Phase 2.2 (a clinically useful record is creatable entirely manually;
 * scan is a shortcut, never a requirement), `08` (the Product Trust Passport keeps identity,
 * formulation and batch separate, and a barcode speaks only to the first), `09` (unconfirmed
 * machine output never becomes trusted truth), `17` (AI and automation policy: a machine reading
 * is an observation awaiting confirmation), `16` (request only permissions a visible feature
 * needs), `BLK-003`.
 *
 * A SCAN IS A FASTER WAY TO TYPE, AND NOTHING ELSE
 * The camera reads digits off a printed symbol. That is the whole of what happens: no product is
 * looked up, no formulation is resolved, no safety rule fires, and nothing about the item becomes
 * more certain. The result lands in exactly the field a person would have typed it into, in the
 * same `UNVERIFIED` state, and the screen says a person has to confirm it.
 *
 * The temptation this module exists to refuse is the obvious one - a scan *feels* authoritative
 * because a machine did it, and `09` is specific that it is not. `BLK-003` is the practical half:
 * there is no GTIN-to-product provider, so a scanned barcode cannot be resolved to anything even
 * if the policy allowed it. Both facts point the same way and only one of them will go away.
 *
 * WHY VALIDATION IS SHAPE-ONLY
 * A GTIN's check digit is arithmetic, not a lookup, so it can be verified offline - and it is
 * worth verifying, because a misread symbol produces digits that look exactly like a real
 * barcode. What it establishes is that the digits are *well-formed*, which is a statement about
 * the number and not about the product. Calling that "verified" anywhere in the UI would be
 * exactly the confusion `08` separates the three axes to prevent.
 */

/**
 * Symbologies a product barcode may use.
 *
 * Narrow on purpose. A QR code on a pack is a marketing URL far more often than a product
 * identifier, and reading one into the GTIN field would put a web address where a number belongs.
 * `BarcodeType` in `expo-camera` is far wider than this; the app asks for these four.
 */
export const PRODUCT_BARCODE_SYMBOLOGIES = ['ean13', 'ean8', 'upc_a', 'upc_e'] as const;
export type ProductBarcodeSymbology = (typeof PRODUCT_BARCODE_SYMBOLOGIES)[number];

export function isProductBarcodeSymbology(value: string): value is ProductBarcodeSymbology {
  return (PRODUCT_BARCODE_SYMBOLOGIES as readonly string[]).includes(value);
}

export type ScanRejectionReason =
  /** The symbology is not one a product barcode uses - most often a QR code. */
  | 'NOT_A_PRODUCT_BARCODE'
  /** Digits only, and 8, 12, 13 or 14 of them. */
  | 'NOT_A_GTIN_SHAPE'
  /** The shape is right and the arithmetic is not, so the read is unreliable. */
  | 'CHECK_DIGIT_FAILED';

export type ScanOutcome =
  | {
      readonly kind: 'ACCEPTED';
      readonly gtin: string;
      readonly symbology: ProductBarcodeSymbology;
    }
  | { readonly kind: 'REJECTED'; readonly reason: ScanRejectionReason };

/**
 * The GTIN check digit, computed the way GS1 defines it.
 *
 * Right to left from the digit before the check digit, alternating weights of 3 and 1. The same
 * arithmetic for GTIN-8, -12, -13 and -14, which is why one function covers all four lengths.
 */
function gtinCheckDigit(digitsWithoutCheck: string): number {
  let sum = 0;
  for (let index = digitsWithoutCheck.length - 1, weight = 3; index >= 0; index -= 1) {
    sum += Number(digitsWithoutCheck[index]) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Judge one camera read.
 *
 * Deliberately total and deliberately offline. It answers "is this a well-formed product barcode"
 * and nothing else - not whether the product exists, not whether it is this person's medicine,
 * and not whether anything about the item is now known.
 */
export function judgeScan(input: {
  readonly symbology: string;
  readonly data: string;
}): ScanOutcome {
  if (!isProductBarcodeSymbology(input.symbology)) {
    return { kind: 'REJECTED', reason: 'NOT_A_PRODUCT_BARCODE' };
  }

  const digits = input.data.trim();
  if (!/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(digits)) {
    return { kind: 'REJECTED', reason: 'NOT_A_GTIN_SHAPE' };
  }

  const body = digits.slice(0, -1);
  const check = Number(digits[digits.length - 1]);
  if (gtinCheckDigit(body) !== check) {
    return { kind: 'REJECTED', reason: 'CHECK_DIGIT_FAILED' };
  }

  return { kind: 'ACCEPTED', gtin: digits, symbology: input.symbology };
}

/**
 * How a camera permission request may end.
 *
 * `canAskAgain` is the distinction that matters and the one a naive model loses: a person who
 * said no once can be asked again in context, and a person who said "don't ask again" cannot be
 * asked by the app at all. Telling the second group to "allow camera access" sends them to press
 * a button that will never appear.
 */
export type CameraPermissionState =
  /** Not asked yet. The app must not ask until somebody chooses to scan (`16`). */
  | 'UNDETERMINED'
  | 'GRANTED'
  /** Refused, and the app may ask again next time. */
  | 'DENIED'
  /** Refused permanently, or blocked by policy. Only Settings can change it. */
  | 'BLOCKED';

export function cameraPermissionState(
  response: {
    readonly granted: boolean;
    readonly canAskAgain: boolean;
    readonly status: string;
  } | null,
): CameraPermissionState {
  if (response === null) return 'UNDETERMINED';
  if (response.granted) return 'GRANTED';
  if (response.status === 'undetermined') return 'UNDETERMINED';
  return response.canAskAgain ? 'DENIED' : 'BLOCKED';
}

/**
 * Whether the app may put the camera on screen.
 *
 * One function so no screen decides it twice. `16` requires a permission to be requested by a
 * visible feature at the moment it is used, which means the answer is never cached across
 * sessions and never assumed from the manifest.
 */
export function mayOpenCamera(state: CameraPermissionState): boolean {
  return state === 'GRANTED';
}

/**
 * Whether a person can still be asked in the app.
 *
 * The screen shows a "try again" control on `DENIED` and a Settings instruction on `BLOCKED`, and
 * offering the wrong one is the failure this exists to prevent: a retry button that does nothing
 * teaches somebody the app is broken, at the moment they were trying to cooperate with it.
 */
export function mayRequestCameraAgain(state: CameraPermissionState): boolean {
  return state === 'UNDETERMINED' || state === 'DENIED';
}
