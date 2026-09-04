import { describe, it, expect, beforeEach } from 'vitest';
import { SCAN_COPY, scanRejectionNote } from '@kynviora/presentation';
import {
  cameraIsOpen,
  cameraRequestCount,
  emitBarcode,
  requestedBarcodeTypes,
  resetCamera,
  setCameraPermission,
} from '../../../test/stubs/expo-camera.js';
import { flush, hasName, press, renderScreen, screenNames } from '../../../test/render.js';
import { ScanBarcode } from './ScanBarcode';

/**
 * Reading the number under a barcode.
 *
 * Spec references: `16` (request only permissions a visible feature needs, at the moment it is
 * used; prominent disclosure first; no broad storage permission), `09` and `17` (unconfirmed
 * machine output never becomes trusted truth), `04` Phase 2.2 (manual entry is the complete path),
 * `18`, DEC-045, `BLK-003`.
 *
 * FOUR THINGS THIS FILE IS ACTUALLY ABOUT
 *
 * 1. **Nothing is asked for until somebody asks.** `16`'s rule, and the one a permission is most
 *    likely to break by drifting into a provider or a layout effect. Measured as a count.
 * 2. **A refusal the app can retry and one it cannot get different screens.** Offering "try
 *    again" on a blocked permission is a button that does nothing, shown to somebody who was
 *    trying to cooperate.
 * 3. **A read is held for confirmation and never described as checked.** `09`, at the moment the
 *    product feels most authoritative - a machine reading feels settled in a way typing does not.
 * 4. **Typing is available from every state.** Including the one where the camera is working, so
 *    it is never the consolation prize for a failed scan.
 */

const VALID_EAN13 = '5012345678900';
const BAD_CHECK_EAN13 = '5012345678901';

const GRANTED = { granted: true, canAskAgain: false, status: 'granted', expires: 'never' } as const;
const DENIED = { granted: false, canAskAgain: true, status: 'denied', expires: 'never' } as const;
const BLOCKED = { granted: false, canAskAgain: false, status: 'denied', expires: 'never' } as const;

function screen() {
  const calls: string[] = [];
  const rendered = renderScreen(
    <ScanBarcode
      onConfirmed={(gtin) => calls.push(`confirmed:${gtin}`)}
      onEnterManually={() => calls.push('manual')}
      onCancel={() => calls.push('cancel')}
    />,
  );
  return { rendered, calls };
}

const joined = (r: ReturnType<typeof screen>['rendered']) => screenNames(r).join(' | ');

beforeEach(() => {
  resetCamera();
});

describe('the permission is asked for just in time', () => {
  it('asks for nothing on render', async () => {
    // `16`. A camera permission requested by a layout, a provider or an effect is one nobody
    // chose, and the manifest already declares `android.permission.CAMERA` - so the runtime
    // request is the only thing standing between the declaration and a prompt at launch.
    screen();
    await flush();
    expect(cameraRequestCount()).toBe(0);
    expect(cameraIsOpen()).toBe(false);
  });

  it('says what the camera is for before the system dialog', () => {
    // Android's own dialog says "take pictures and record video", which is true of a camera and
    // useless about this feature. `16` asks for the disclosure to come first.
    const { rendered } = screen();
    const text = joined(rendered);
    expect(text).toContain(SCAN_COPY.disclosure);
    // And the three facts it has to carry: what it does, what it does not keep, and that typing
    // works instead.
    expect(SCAN_COPY.disclosure).toMatch(/read the number/i);
    expect(SCAN_COPY.disclosure).toMatch(/does not take a photograph/i);
    expect(SCAN_COPY.disclosure).toMatch(/type the number instead/i);
  });

  it('asks exactly once when the control is pressed', async () => {
    const { rendered } = screen();
    press(rendered, SCAN_COPY.requestLabel);
    await flush();
    expect(cameraRequestCount()).toBe(1);
  });
});

describe('a refusal', () => {
  it('offers to ask again where asking can succeed, and does not blame anybody', async () => {
    // The refusal states are reached by **pressing** first, not by loading. Android reports
    // `canAskAgain: false` for a permission nobody has ever asked for, so a screen that trusted
    // the response on first load would show a refusal to a first-time user (`DEV-060`).
    setCameraPermission(null, DENIED);
    const { rendered } = screen();
    press(rendered, SCAN_COPY.requestLabel);
    await flush();
    const text = joined(rendered);

    expect(text).toContain(SCAN_COPY.deniedHeading);
    expect(text).toContain(SCAN_COPY.deniedNote);
    expect(hasName(rendered, SCAN_COPY.requestLabel)).toBe(true);
    // `16` and `18` both point the same way: declining a permission is a choice being respected,
    // and copy that treats it as an error is pressure applied to one side.
    expect(SCAN_COPY.deniedNote).toMatch(/that is fine/i);
  });

  it('shows the disclosure to somebody who has never been asked', async () => {
    // The defect a device run found. Android cannot distinguish "never asked" from "don’t ask
    // again", so this exact response arrives for a first-time user - and the screen must offer
    // the camera rather than tell them it is switched off.
    setCameraPermission(BLOCKED);
    const { rendered } = screen();
    await flush();
    const text = joined(rendered);

    expect(text).toContain(SCAN_COPY.disclosure);
    expect(text).not.toContain(SCAN_COPY.blockedHeading);
    expect(hasName(rendered, SCAN_COPY.requestLabel)).toBe(true);
  });

  it('sends a blocked permission to Settings once it has actually been asked', async () => {
    // The distinction a naive model loses. A retry control here cannot work, and offering one
    // teaches somebody the app is broken at the moment they were trying to cooperate.
    setCameraPermission(null, BLOCKED);
    const { rendered } = screen();
    press(rendered, SCAN_COPY.requestLabel);
    await flush();
    const text = joined(rendered);

    expect(text).toContain(SCAN_COPY.blockedHeading);
    expect(text).toContain(SCAN_COPY.blockedNote);
    expect(hasName(rendered, SCAN_COPY.requestLabel)).toBe(false);
    // And it says where, because "check your settings" is not an instruction anybody can follow.
    expect(SCAN_COPY.blockedNote).toMatch(/Settings, under Apps, Kynviora, Permissions/);
  });

  it('never opens the camera without a grant', async () => {
    for (const state of [null, DENIED, BLOCKED]) {
      resetCamera();
      setCameraPermission(state);
      screen();
      await flush();
      expect(cameraIsOpen()).toBe(false);
    }
  });

  it('leaves the manual path available on every one of them', () => {
    // `04` Phase 2.2: manual entry is the complete path. Somebody who declines the camera lands
    // on a form rather than an apology.
    for (const state of [null, DENIED, BLOCKED, GRANTED]) {
      resetCamera();
      setCameraPermission(state);
      const { rendered, calls } = screen();
      expect(hasName(rendered, SCAN_COPY.manualLabel)).toBe(true);
      press(rendered, SCAN_COPY.manualLabel);
      expect(calls).toEqual(['manual']);
    }
  });
});

describe('with the camera open', () => {
  it('asks for four symbologies and not everything the module can read', async () => {
    // Narrowing here is what stops a QR code reaching the judge at all. A QR on a pack is a
    // marketing URL far more often than a product identifier.
    setCameraPermission(GRANTED);
    screen();
    await flush();
    expect([...requestedBarcodeTypes()]).toEqual(['ean13', 'ean8', 'upc_a', 'upc_e']);
  });

  it('holds a good read for confirmation rather than returning it', async () => {
    // `09`. The digits go onto a medicine, where a wrong number is a claim about which product
    // this is - so a machine reading does not become a record on its own.
    setCameraPermission(GRANTED);
    const { rendered, calls } = screen();
    await flush();

    emitBarcode({ type: 'ean13', data: VALID_EAN13 });
    await flush();

    expect(calls).toEqual([]);
    const text = joined(rendered);
    expect(text).toContain(VALID_EAN13);
    expect(text).toContain(SCAN_COPY.unverifiedNote);
  });

  it('says the number has been checked against nothing', async () => {
    // The sentence this whole screen is at risk of losing. On the result, not in a help panel,
    // because the alternative is a person believing the machine settled something.
    setCameraPermission(GRANTED);
    const { rendered } = screen();
    await flush();
    emitBarcode({ type: 'ean13', data: VALID_EAN13 });
    await flush();

    expect(SCAN_COPY.unverifiedNote).toMatch(/has not checked this against anything/i);
    expect(joined(rendered)).toContain(SCAN_COPY.noLookupNote);
    // And nowhere on this screen does anything claim a verification.
    expect(joined(rendered)).not.toMatch(/confirmed|verified|matched/i);
  });

  it('returns the number only when somebody presses through it', async () => {
    setCameraPermission(GRANTED);
    const { rendered, calls } = screen();
    await flush();
    emitBarcode({ type: 'ean13', data: VALID_EAN13 });
    await flush();

    press(rendered, SCAN_COPY.confirmLabel);
    expect(calls).toEqual([`confirmed:${VALID_EAN13}`]);
  });

  it('ignores every frame after the first read', async () => {
    // `CameraView` fires continuously while a symbol is in frame. A screen that re-judged each
    // one would replace a person's result many times a second, which makes the confirm control
    // unpressable - and would let a second pack in view overwrite the first silently.
    setCameraPermission(GRANTED);
    const { rendered, calls } = screen();
    await flush();

    emitBarcode({ type: 'ean13', data: VALID_EAN13 });
    await flush();
    emitBarcode({ type: 'ean13', data: '4006381333931' });
    await flush();

    expect(joined(rendered)).toContain(VALID_EAN13);
    press(rendered, SCAN_COPY.confirmLabel);
    expect(calls).toEqual([`confirmed:${VALID_EAN13}`]);
  });

  it('explains a misread as a fact about the read', async () => {
    // The check digit failing means the camera did not see it cleanly. Sending somebody to look
    // for a different pack would be the wrong instruction.
    setCameraPermission(GRANTED);
    const { rendered } = screen();
    await flush();
    emitBarcode({ type: 'ean13', data: BAD_CHECK_EAN13 });
    await flush();

    expect(joined(rendered)).toContain(scanRejectionNote('CHECK_DIGIT_FAILED'));
    expect(scanRejectionNote('CHECK_DIGIT_FAILED')).toMatch(/did not read that cleanly/i);
    // No confirm control over a rejected read.
    expect(hasName(rendered, SCAN_COPY.confirmLabel)).toBe(false);
  });

  it('explains a QR code as the wrong kind of code', async () => {
    setCameraPermission(GRANTED);
    const { rendered } = screen();
    await flush();
    emitBarcode({ type: 'qr', data: 'https://example.test/promo' });
    await flush();

    expect(joined(rendered)).toContain(scanRejectionNote('NOT_A_PRODUCT_BARCODE'));
    // And the URL is not shown back. It came off somebody's pack and this screen has no reason to
    // put an unvisited link on a medicine record.
    expect(joined(rendered)).not.toContain('example.test');
  });
});
