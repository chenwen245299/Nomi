import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

export type UpdaterState = "idle" | "checking" | "available" | "downloading" | "ready" | "error";

export interface UpdaterSnapshot {
  state: UpdaterState;
  currentVersion: string;
  newVersion: string;
  releaseNotes: string;
  progress: number;
  error: string;
  upToDateFlash: boolean;
  dialogOpen: boolean;
}

let snapshot: UpdaterSnapshot = {
  state: "idle",
  currentVersion: "",
  newVersion: "",
  releaseNotes: "",
  progress: 0,
  error: "",
  upToDateFlash: false,
  dialogOpen: false,
};

const listeners = new Set<() => void>();

function set(patch: Partial<UpdaterSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) {
    listener();
  }
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): UpdaterSnapshot {
  return snapshot;
}

const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let pending: Update | null = null;
let lastPromptedVersion = "";
let flashTimer: ReturnType<typeof setTimeout> | null = null;

export function openDialog(): void {
  set({ dialogOpen: true });
}

export function closeDialog(): void {
  // No backing out once the download is under way; the relaunch takes over.
  if (snapshot.state === "downloading") {
    return;
  }
  set({ dialogOpen: false });
}

export async function initVersion(): Promise<void> {
  if (!isTauri()) {
    return;
  }
  try {
    set({ currentVersion: await getVersion() });
  } catch (e) {
    console.error("getVersion failed", e);
  }
}

// ── "checked today?" persistence ────────────────────────────────────────────
// Lets an app that's left running for days still get a once-a-day check, and
// keeps the 9am catch-up from firing more than once per day.
const LAST_CHECK_KEY = "nomi:lastUpdateCheck";

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function markCheckedToday(): void {
  try {
    localStorage.setItem(LAST_CHECK_KEY, todayStr());
  } catch {
    // storage disabled (private mode etc.) — best effort only
  }
}

function checkedToday(): boolean {
  try {
    return localStorage.getItem(LAST_CHECK_KEY) === todayStr();
  } catch {
    return false;
  }
}

export async function checkForUpdates(manual: boolean): Promise<void> {
  if (snapshot.state === "downloading") {
    return;
  }

  if (!isTauri()) {
    if (manual) {
      set({ error: "更新检查只在桌面应用中可用。" });
    }
    return;
  }

  if (manual) {
    set({ state: "checking", error: "", upToDateFlash: false });
  } else {
    set({ error: "" });
  }

  try {
    const update = await check();
    markCheckedToday();

    if (update) {
      pending = update;
      set({
        state: "available",
        newVersion: update.version,
        releaseNotes: update.body ?? "",
      });
      // Manual checks always surface the dialog. Auto checks pop it once per
      // newly-found version, so a long-running app is notified without nagging.
      if (manual || lastPromptedVersion !== update.version) {
        lastPromptedVersion = update.version;
        set({ dialogOpen: true });
      }
    } else {
      set({ state: "idle", newVersion: "", releaseNotes: "" });
      if (manual) {
        if (flashTimer) {
          clearTimeout(flashTimer);
        }
        set({ upToDateFlash: true });
        flashTimer = setTimeout(() => set({ upToDateFlash: false }), 3000);
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    set({ state: "idle" });
    if (manual) {
      set({ error: `检查失败：${message}` });
    } else {
      console.error("auto update check failed", e);
    }
  }
}

export async function downloadAndInstall(): Promise<void> {
  if (!pending) {
    return;
  }

  set({ state: "downloading", progress: 0, error: "" });

  try {
    let downloaded = 0;
    let total = 0;

    await pending.downloadAndInstall((event: DownloadEvent) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        if (total > 0) {
          set({ progress: Math.min(100, Math.floor((downloaded / total) * 100)) });
        }
      } else if (event.event === "Finished") {
        set({ progress: 100 });
      }
    });

    set({ state: "ready", progress: 100 });
    await relaunch();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    set({ state: "error", error: `更新失败：${message}` });
  }
}

// ── scheduling: startup catch-up + daily 9am for always-on windows ──────────
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

const CHECK_HOUR = 9;
const TICK_MS = 15 * 60 * 1000; // re-evaluate every 15 min

export function startAutoUpdate(): void {
  if (!isTauri()) {
    return;
  }
  stopAutoUpdate();

  // 1) Catch-up check a few seconds after launch (let network/endpoint settle).
  startupTimer = setTimeout(() => {
    void checkForUpdates(false);
  }, 8000);

  // 2) Daily check for windows left open for days. A repeating interval (rather
  //    than a single timer aimed at 9am) survives system sleep: on wake the next
  //    tick notices the day rolled over and runs the still-missing check.
  ticker = setInterval(() => {
    if (new Date().getHours() >= CHECK_HOUR && !checkedToday()) {
      void checkForUpdates(false);
    }
  }, TICK_MS);
}

export function stopAutoUpdate(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}
