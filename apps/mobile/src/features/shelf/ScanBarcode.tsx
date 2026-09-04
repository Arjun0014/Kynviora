/**
 * Reading the number under a barcode (`04` Phase 2.2, `16`, `09`).
 *
 * Spec references: `16` (request only permissions a visible feature needs, at the moment it is
 * used; prominent disclosure before a sensitive permission; no broad storage permission),
 * `09` and `17` (unconfirmed machine output never becomes trusted truth), `18` (a control is
 * absent rather than disabled; say what a screen will do before it does it), `04` Phase 2.2
 * (manual entry is the complete path and a scan is a shortcut), `12`, `BLK-003`, `BLK-007`.
 *
 * JUST IN TIME, AND ONLY HERE
 * The camera permission is requested by this screen, when somebody presses the control, and
 * nowhere else. Not at launch, not on the shelf, not on the add-an-item form. `16` asks for a
 * permission to be requested by a visible feature at the moment it is used, and the only moment
 * this app has a use for a camera is the one where a person has said "scan the barcode".
 *
 * NO STORAGE PERMISSION AT ALL
 * There is no gallery picker, no file browse, and no `READ_MEDIA_IMAGES`. A person who wants to
 * scan points the camera at the pack; a person who does not types the number. Adding a "choose a
 * photo" path would need a permission over every image on the device to read digits off one of
 * them, which is the kind of over-granting `16` names specifically.
 *
 * WHAT HAPPENS TO WHAT THE CAMERA SEES
 * Nothing. `CameraView` renders a live preview and reports barcodes it recognises; no frame is
 * captured, written or sent. That is what the disclosure says and it is worth saying, because
 * every other camera screen a person has used was taking a photograph.
 *
 * A SCAN IS A FASTER WAY TO TYPE
 * The digits land in `recordedGtin` in the same `UNVERIFIED` state a typed number would, and the
 * result screen says so. Nothing is looked up - `BLK-003` means nothing *can* be - and nothing
 * about the item becomes more certain. `09` is the rule and this is the screen where it would be
 * easiest to break, because a machine reading feels authoritative in a way typing does not.
 */

import { useCallback, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  SCAN_COPY,
  describeScanPermission,
  scanRejectionNote,
} from '@kynviora/presentation';
import {
  PRODUCT_BARCODE_SYMBOLOGIES,
  cameraPermissionState,
  judgeScan,
  mayOpenCamera,
  type ScanOutcome,
} from '@kynviora/domain';
import { PrimaryButton } from '@/components/PrimaryButton';

export interface ScanBarcodeProps {
  /**
   * Called with a well-formed GTIN the person has confirmed.
   *
   * Confirmed, not read. The screen holds a successful read until somebody presses through it,
   * because `09` will not let a machine reading become a record on its own - and because the
   * number goes onto a medicine, where a wrong one is a claim about which product this is.
   */
  readonly onConfirmed: (gtin: string) => void;
  /**
   * The way out that always works.
   *
   * Present on every state of this screen including the successful one. `04` Phase 2.2 makes
   * manual entry the complete path, so it is never the consolation prize for a failed scan.
   */
  readonly onEnterManually: () => void;
  readonly onCancel: () => void;
}

export function ScanBarcode({ onConfirmed, onEnterManually, onCancel }: ScanBarcodeProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [outcome, setOutcome] = useState<ScanOutcome | null>(null);
  /**
   * Whether this screen has asked yet.
   *
   * Load-bearing, and Android is why. `canAskAgain` comes from
   * `shouldShowRequestPermissionRationale`, which returns `false` both before the first request
   * and after somebody chooses "don't ask again" - the platform does not distinguish them. Only
   * the app knows which it is, and this is how it knows (`DEV-060`).
   *
   * Screen-local rather than persisted. It resets when the screen closes, which is right: a
   * person returning tomorrow should be offered the ask again, and the response after that first
   * request tells the truth.
   */
  const [hasRequested, setHasRequested] = useState(false);

  const state = cameraPermissionState(permission, hasRequested);
  const words = describeScanPermission(state);

  const onBarcode = useCallback(
    (result: { type: string; data: string }) => {
      // Ignored once something has been read. `CameraView` fires continuously while a symbol is
      // in frame, and a screen that re-judged every frame would replace a person's result with an
      // identical one many times a second - which makes the confirm control unpressable.
      setOutcome((current) =>
        current === null ? judgeScan({ symbology: result.type, data: result.data }) : current,
      );
    },
    [setOutcome],
  );

  // A successful read, held until somebody presses through it.
  if (outcome !== null && outcome.kind === 'ACCEPTED') {
    return (
      <View style={styles.container}>
        <Text accessibilityRole="header" style={styles.heading}>
          {SCAN_COPY.readHeading}
        </Text>
        <Text accessibilityLiveRegion="polite" style={styles.digits}>
          {outcome.gtin}
        </Text>

        {/* `09`, at the moment the product feels most authoritative. On the result rather than in
            a help panel, because the alternative is a person believing the machine settled
            something. */}
        <Text style={styles.limitation}>{SCAN_COPY.unverifiedNote}</Text>
        <Text style={styles.help}>{SCAN_COPY.noLookupNote}</Text>

        <PrimaryButton
          label={SCAN_COPY.confirmLabel}
          accessibilityHint={SCAN_COPY.unverifiedNote}
          onPress={() => {
            onConfirmed(outcome.gtin);
          }}
        />
        <PrimaryButton
          label={SCAN_COPY.rescanLabel}
          variant="secondary"
          onPress={() => {
            setOutcome(null);
          }}
        />
        <PrimaryButton
          label={SCAN_COPY.manualLabel}
          variant="secondary"
          onPress={onEnterManually}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        {words.heading}
      </Text>
      <Text style={styles.body}>{words.note}</Text>

      {/* A read the app could not use. Said as a fact about the read rather than about the
          person: the check digit failing means the camera did not see it cleanly, and sending
          somebody to look for a different pack would be the wrong instruction. */}
      {outcome !== null && outcome.kind === 'REJECTED' ? (
        <Text accessibilityLiveRegion="polite" style={styles.limitation}>
          {scanRejectionNote(outcome.reason)}
        </Text>
      ) : null}

      {mayOpenCamera(state) ? (
        <CameraView
          style={styles.preview}
          facing="back"
          // Four symbologies, not everything the module can read. A QR code on a pack is a
          // marketing URL far more often than a product identifier, and asking the camera for
          // fewer kinds is also what stops one being offered to `judgeScan` at all.
          barcodeScannerSettings={{ barcodeTypes: [...PRODUCT_BARCODE_SYMBOLOGIES] }}
          onBarcodeScanned={onBarcode}
        />
      ) : null}

      {/* Absent rather than disabled where asking cannot succeed (DEC-045). A retry control on a
          blocked permission is a button that does nothing, offered to somebody who was trying to
          cooperate. */}
      {words.requestLabel === null ? null : (
        <PrimaryButton
          label={words.requestLabel}
          accessibilityHint={SCAN_COPY.openHint}
          onPress={() => {
            setHasRequested(true);
            void requestPermission();
          }}
        />
      )}

      {/* On every state, including the one where the camera is working. Manual entry is the
          complete path (`04` Phase 2.2), not the consolation prize for a failed scan. */}
      <PrimaryButton label={SCAN_COPY.manualLabel} variant="secondary" onPress={onEnterManually} />
      <PrimaryButton label={SCAN_COPY.cancelLabel} variant="secondary" onPress={onCancel} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: SPACING.md },
  heading: {
    fontSize: FONT_SIZE.title,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  body: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surface.foreground,
  },
  // The number, large enough to check against a pack without picking the phone up. That is the
  // whole job of this line: somebody has been asked to confirm it.
  digits: {
    fontSize: FONT_SIZE.title,
    fontWeight: '600',
    letterSpacing: 2,
    color: LIGHT_THEME.surface.foreground,
  },
  help: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
  // Informational rather than attention-toned. "Kynviora has not checked this" is a fact about
  // what the product knows, not a warning about the medicine - and `02` will not let a screen
  // borrow alarm from one to make the other feel important.
  limitation: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.informational.foreground,
    backgroundColor: LIGHT_THEME.informational.background,
    borderColor: LIGHT_THEME.informational.border,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    padding: SPACING.sm,
  },
  preview: {
    height: 260,
    borderRadius: SPACING.sm,
    overflow: 'hidden',
  },
});
