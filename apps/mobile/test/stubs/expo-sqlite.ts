/** `expo-sqlite`, importable and loud. See `unavailable.ts`. */
import { unavailable } from './unavailable.js';

export const openDatabaseAsync = (): never => unavailable('SQLite', 'openDatabaseAsync');
export const deleteDatabaseAsync = (): never => unavailable('SQLite', 'deleteDatabaseAsync');
export type SQLiteDatabase = Record<string, never>;
