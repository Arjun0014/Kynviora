/**
 * `expo-notifications`, importable and loud. See `unavailable.ts`.
 *
 * `setNotificationHandler` is the one call that does nothing rather than throwing: `_layout.tsx`
 * makes it at module scope, so throwing would make every screen unimportable - and registering a
 * handler is a declaration rather than a use of the platform.
 */
import { unavailable } from './unavailable.js';

export const getPermissionsAsync = (): never => unavailable('Notifications', 'getPermissionsAsync');
export const requestPermissionsAsync = (): never =>
  unavailable('Notifications', 'requestPermissionsAsync');
export const scheduleNotificationAsync = (): never =>
  unavailable('Notifications', 'scheduleNotificationAsync');
export const cancelScheduledNotificationAsync = (): never =>
  unavailable('Notifications', 'cancelScheduledNotificationAsync');
export const getAllScheduledNotificationsAsync = (): never =>
  unavailable('Notifications', 'getAllScheduledNotificationsAsync');
export const setNotificationChannelAsync = (): never =>
  unavailable('Notifications', 'setNotificationChannelAsync');
export const setNotificationHandler = (): void => undefined;
export const AndroidImportance = { DEFAULT: 3, HIGH: 4 } as const;
export const AndroidNotificationPriority = { DEFAULT: 'default', HIGH: 'high' } as const;
export const SchedulableTriggerInputTypes = { DATE: 'date' } as const;
