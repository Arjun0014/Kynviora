/**
 * `expo-camera`, importable and controllable.
 *
 * Unlike the other stubs in this directory this one does **not** throw on use, and the reason is
 * the shape of what is being tested. The interesting behaviour of `ScanBarcode` is entirely in
 * what it does with a permission answer and a barcode read - which control it offers on a refusal
 * it can retry versus one it cannot, whether a read is held for confirmation, what it says about
 * a number nothing has checked. All of that is decidable in Node; none of it needs a camera.
 *
 * WHAT THIS CANNOT SUBSTITUTE, AND THEREFORE WHAT A DEVICE RUN IS STILL FOR
 * That Android's permission dialog appears at all, and appears when the control is pressed rather
 * than at launch. That declining it leaves the app usable. That a real symbol on a real pack in
 * real light produces the digits underneath it. That no photograph is written anywhere. Those are
 * `19` scenario questions and `npm run verify:device:camera` is where they are answered.
 *
 * `setCameraPermission` and `emitBarcode` are the two levers a test needs, and both are explicit:
 * a test that wanted a granted camera has to say so, so no test is accidentally measuring the
 * default.
 */

import { createElement, type ReactElement } from 'react';

export interface StubPermissionResponse {
  readonly granted: boolean;
  readonly canAskAgain: boolean;
  readonly status: string;
  readonly expires: 'never';
}

const DENIED_ONCE: StubPermissionResponse = {
  granted: false,
  canAskAgain: true,
  status: 'denied',
  expires: 'never',
};

/**
 * The answer the next `useCameraPermissions()` will report, and `null` for "not asked".
 *
 * `null` rather than an `undetermined` response, because that is what the real hook returns
 * before its first read - and a screen that treated the two differently would be one this stub
 * could not catch.
 */
let current: StubPermissionResponse | null = null;
/** What `requestPermission()` will resolve to. Defaults to a refusal the app may retry. */
let onRequest: StubPermissionResponse = DENIED_ONCE;

let barcodeListener: ((result: { type: string; data: string }) => void) | null = null;
let requestCount = 0;

export function setCameraPermission(
  next: StubPermissionResponse | null,
  answerToRequest: StubPermissionResponse = DENIED_ONCE,
): void {
  current = next;
  onRequest = answerToRequest;
}

export function resetCamera(): void {
  current = null;
  onRequest = DENIED_ONCE;
  barcodeListener = null;
  requestCount = 0;
}

/** How many times the screen asked. `16` cares that it is zero until somebody presses. */
export function cameraRequestCount(): number {
  return requestCount;
}

/** Whether a preview is on screen, which is the only thing that would use the camera. */
export function cameraIsOpen(): boolean {
  return barcodeListener !== null;
}

/** Deliver a read to whatever `CameraView` is mounted. */
export function emitBarcode(result: { type: string; data: string }): void {
  barcodeListener?.(result);
}

export const useCameraPermissions = (): [
  StubPermissionResponse | null,
  () => Promise<StubPermissionResponse>,
  () => Promise<StubPermissionResponse>,
] => [
  current,
  () => {
    requestCount += 1;
    current = onRequest;
    return Promise.resolve(onRequest);
  },
  () => Promise.resolve(current ?? DENIED_ONCE),
];

export interface StubCameraViewProps {
  readonly onBarcodeScanned?: (result: { type: string; data: string }) => void;
  readonly barcodeScannerSettings?: { barcodeTypes: readonly string[] };
  readonly facing?: string;
  readonly style?: unknown;
}

/**
 * The preview.
 *
 * Registers its listener as a side effect of rendering rather than in an effect, so a test that
 * renders and immediately emits does not have to flush - and records the symbologies it was asked
 * for, which is the one prop worth asserting: asking the camera for fewer kinds is what stops a
 * QR code reaching the judge at all.
 */
export function CameraView(props: StubCameraViewProps): ReactElement {
  barcodeListener = props.onBarcodeScanned ?? null;
  lastRequestedTypes = props.barcodeScannerSettings?.barcodeTypes ?? [];
  return createElement('CameraView', { testID: 'camera-preview' });
}

let lastRequestedTypes: readonly string[] = [];

export function requestedBarcodeTypes(): readonly string[] {
  return lastRequestedTypes;
}
