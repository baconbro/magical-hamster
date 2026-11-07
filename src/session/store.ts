import { createStore, type StoreApi } from 'zustand/vanilla';
import type { HamsterState } from '../types.ts';

/** The single state container. The session writes it; React only reads it. */
export type HamsterStoreApi = StoreApi<HamsterState>;

export function createHamsterStore(initial: HamsterState): HamsterStoreApi {
  return createStore<HamsterState>(() => initial);
}
