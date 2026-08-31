import { useSyncExternalStore } from "react";
import { getSnapshot, subscribe, type UpdaterSnapshot } from "./store";

export function useUpdater(): UpdaterSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
