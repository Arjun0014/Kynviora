/** `expo-secure-store`, importable and loud. See `unavailable.ts`. */
import { unavailable } from './unavailable.js';

export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 'WHEN_UNLOCKED_THIS_DEVICE_ONLY';
export const getItemAsync = (): never => unavailable('SecureStore', 'getItemAsync');
export const setItemAsync = (): never => unavailable('SecureStore', 'setItemAsync');
export const deleteItemAsync = (): never => unavailable('SecureStore', 'deleteItemAsync');
export const isAvailableAsync = (): never => unavailable('SecureStore', 'isAvailableAsync');
