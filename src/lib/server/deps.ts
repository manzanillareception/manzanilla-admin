import { createStoreFromEnv } from './supabase-store';
import type { ControlStore } from './types';

export interface Deps {
  store: ControlStore;
  now: () => Date;
}

/**
 * Route handlers resolve deps per request so tests can inject a memory store.
 * Unconfigured environments fail closed at the store boundary (SETUP_REQUIRED).
 */
export function defaultDeps(): { store: ControlStore | null; now: () => Date } {
  return { store: createStoreFromEnv(), now: () => new Date() };
}

export type { Deps as HandlerDeps };
