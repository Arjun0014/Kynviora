/**
 * Scanning a barcode, in words (`04` Phase 2.2, `16`, `18`, `09`).
 *
 * Spec references: `16` (request only permissions a visible feature needs; prominent disclosure
 * before a sensitive permission; no broad storage permission), `18` (say what a screen will do
 * before it does it; familiar words first; a control is absent rather than disabled), `09` and
 * `17` (unconfirmed machine output never becomes trusted truth), `04` Phase 2.2 (a clinically
 * useful record is creatable entirely manually), `BLK-003`, `BLK-007`.
 *
 * WHAT THE COPY HAS TO DO THAT IS NOT OBVIOUS
 *
 * **Say what the camera is for, before it opens.** `16` asks for prominent disclosure ahead of a
 * sensitive permission, and Android's own dialog says only "Allow Kynviora to take pictures and
 * record video" - which is true of a camera and useless about this feature. The sentence before
 * it is where somebody learns the app reads a number off a pack and keeps nothing else.
 *
 * **Say that nothing is kept.** A camera screen looks like it is taking a photograph, because
 * every other camera screen a person has used was. This one reads digits from a live preview and
 * stores no image, and the person has no way to know that unless it is said.
 *
 * **Say that typing works.** `04` Phase 2.2 makes manual entry the complete path and scanning a
 * shortcut. Somebody who declines the camera must land on a form rather than on an apology, and
 * the words for that are here rather than in a screen, so no future screen invents softer ones.
 *
 * **Never say a scan confirmed anything.** `09`. The digits arrive in the same field a person
 * would have typed them into, in the same unverified state, and the copy has to hold that line at
 * exactly the moment the product feels most clever.
 */

import type { CameraPermissionState, ScanRejectionReason } from '@kynviora/domain';

export const SCAN_COPY = Object.freeze({
  openLabel: 'Scan the barcode',
  openHint: 'Uses the camera to read the number under the barcode. No photo is taken or kept.',

  heading: 'Scan the barcode',

  /**
   * The disclosure `16` asks for, before the system dialog rather than after it.
   *
   * Three facts in the order somebody needs them: what it does, what it does not do, and that
   * they can decline and still finish.
   */
  disclosure:
    'Kynviora will use the camera to read the number printed under the barcode. It does not take a photograph, and nothing from the camera is stored or sent anywhere. You can type the number instead if you would rather.',
  requestLabel: 'Use the camera',

  scanningNote: 'Point the camera at the barcode. It will read on its own.',

  /**
   * Denial, where the person can still be asked.
   *
   * Not phrased as a problem. `16` and `18` both point the same way: declining a permission is a
   * choice being respected, and copy that treats it as an error is pressure applied to one side.
   */
  deniedHeading: 'No camera, then',
  deniedNote:
    'That is fine. You can type the number instead, and everything else works exactly the same. If you change your mind, the camera is here whenever you want it.',

  /**
   * Denial, where the app can no longer ask.
   *
   * A different sentence because a different thing is true, and offering "try again" here would
   * be a control that cannot work - which teaches somebody the app is broken at the moment they
   * were trying to cooperate with it.
   */
  blockedHeading: 'The camera is switched off for Kynviora',
  blockedNote:
    'Android will not let Kynviora ask again. You can turn it back on in Settings, under Apps, Kynviora, Permissions. Typing the number works just as well.',

  manualLabel: 'Type the number instead',
  cancelLabel: 'Not now',

  /**
   * What a successful read did and did not establish.
   *
   * The sentence `09` exists for, at the moment the product feels most authoritative. It is shown
   * on the result, not tucked into a help panel, because the alternative is a person believing
   * the machine settled something.
   */
  readHeading: 'Read from the barcode',
  unverifiedNote:
    'Kynviora has not checked this against anything. It is the number the camera read, and it is yours to confirm - check it against the pack before saving.',
  confirmLabel: 'Use this number',
  rescanLabel: 'Scan again',

  /**
   * The one thing `BLK-003` makes true and a person would not guess.
   *
   * Said here rather than left implicit, because a scan that produces a number and no product
   * name reads as a failure unless somebody says it is not one.
   */
  noLookupNote:
    'Kynviora cannot yet look a product up from its barcode, so this adds the number to your record and nothing more.',
});

const REJECTION_NOTES: Readonly<Record<ScanRejectionReason, string>> = Object.freeze({
  /** Almost always a QR code, which on a pack is a marketing link rather than an identifier. */
  NOT_A_PRODUCT_BARCODE:
    'That is a code, but not the kind printed under a product barcode. Try the striped barcode with digits underneath it.',
  NOT_A_GTIN_SHAPE:
    'That did not come out as a product number. Try again with the whole barcode in view.',
  /**
   * The check digit is arithmetic over the digits themselves, so a failure means the read was
   * unreliable rather than that the product is wrong. Saying which matters: the person should
   * re-scan, not go looking for a different pack.
   */
  CHECK_DIGIT_FAILED:
    'The camera did not read that cleanly. Try again, holding the pack still and in good light.',
});

export function scanRejectionNote(reason: ScanRejectionReason): string {
  return REJECTION_NOTES[reason];
}

export interface ScanPermissionWords {
  readonly heading: string;
  readonly note: string;
  /** `null` where asking again cannot succeed, so no screen can offer a control that will not. */
  readonly requestLabel: string | null;
}

/**
 * What to say about the camera permission, and whether to offer to ask again.
 *
 * One function so the two refusals cannot drift into each other. The difference between them is
 * the difference between a person who said no once and a person Android will not let the app ask,
 * and a screen that showed the first sentence to the second group is offering a button that does
 * nothing.
 */
export function describeScanPermission(state: CameraPermissionState): ScanPermissionWords {
  switch (state) {
    case 'UNDETERMINED':
      return {
        heading: SCAN_COPY.heading,
        note: SCAN_COPY.disclosure,
        requestLabel: SCAN_COPY.requestLabel,
      };
    case 'GRANTED':
      return {
        heading: SCAN_COPY.heading,
        note: SCAN_COPY.scanningNote,
        requestLabel: null,
      };
    case 'DENIED':
      return {
        heading: SCAN_COPY.deniedHeading,
        note: SCAN_COPY.deniedNote,
        requestLabel: SCAN_COPY.requestLabel,
      };
    case 'BLOCKED':
      return {
        heading: SCAN_COPY.blockedHeading,
        note: SCAN_COPY.blockedNote,
        requestLabel: null,
      };
  }
}

/** Every sentence this module can put on a screen, for the copy scans. */
export const ALL_SCAN_STRINGS: readonly string[] = Object.freeze([
  ...Object.values(SCAN_COPY),
  ...Object.values(REJECTION_NOTES),
]);
