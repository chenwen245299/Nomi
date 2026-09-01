import { useCallback, useEffect, useRef, useState } from "react";
import {
  createNote as apiCreateNote,
  createPlan as apiCreatePlan,
  deleteNote as apiDeleteNote,
  deletePlan as apiDeletePlan,
  getSettings,
  listMaps,
  listNotes,
  listPlans,
  saveNote as apiSaveNote,
  savePlan as apiSavePlan,
  setSettings,
  updateNote as apiUpdateNote,
  type NoteInput,
  type OfflineMap,
  type PlanInput,
  type TravelNote,
  type TravelPlan,
  type TravelSettings,
} from "./api";

export interface TravelData {
  loading: boolean;
  error: string | null;
  notes: TravelNote[];
  plans: TravelPlan[];
  maps: OfflineMap[];
  settings: TravelSettings | null;
  categories: string[];
  reload: () => Promise<void>;
  refreshMaps: () => Promise<void>;
  findNote: (id: string | null) => TravelNote | undefined;
  createNote: (input: NoteInput) => Promise<TravelNote | null>;
  updateNote: (id: string, input: NoteInput) => Promise<TravelNote | null>;
  deleteNote: (id: string) => Promise<void>;
  saveNoteBody: (id: string, content: string) => Promise<void>;
  createPlan: (input: PlanInput) => Promise<TravelPlan | null>;
  savePlan: (plan: TravelPlan) => Promise<TravelPlan | null>;
  deletePlan: (id: string) => Promise<void>;
  setBasemap: (basemap: string) => Promise<void>;
  dismissError: () => void;
}

export function useTravel(enabled: boolean): TravelData {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<TravelNote[]>([]);
  const [plans, setPlans] = useState<TravelPlan[]>([]);
  const [maps, setMaps] = useState<OfflineMap[]>([]);
  const [settings, setSettingsState] = useState<TravelSettings | null>(null);
  const loadedRef = useRef(false);

  const fail = useCallback(
    (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    [],
  );

  const reload = useCallback(async () => {
    try {
      const [n, p, s, m] = await Promise.all([listNotes(), listPlans(), getSettings(), listMaps()]);
      setNotes(n);
      setPlans(p);
      setSettingsState(s);
      setMaps(m);
    } catch (err) {
      fail(err);
    } finally {
      setLoading(false);
    }
  }, [fail]);

  useEffect(() => {
    if (!enabled || loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    void reload();
  }, [enabled, reload]);

  const refreshMaps = useCallback(async () => {
    try {
      setMaps(await listMaps());
    } catch (err) {
      fail(err);
    }
  }, [fail]);

  const findNote = useCallback(
    (id: string | null) => (id ? notes.find((note) => note.id === id) : undefined),
    [notes],
  );

  const createNote = useCallback(
    async (input: NoteInput) => {
      try {
        const note = await apiCreateNote(input);
        setNotes((prev) => [note, ...prev]);
        return note;
      } catch (err) {
        fail(err);
        return null;
      }
    },
    [fail],
  );

  const updateNote = useCallback(
    async (id: string, input: NoteInput) => {
      try {
        const note = await apiUpdateNote(id, input);
        setNotes((prev) => prev.map((item) => (item.id === id ? note : item)));
        return note;
      } catch (err) {
        fail(err);
        return null;
      }
    },
    [fail],
  );

  const deleteNote = useCallback(
    async (id: string) => {
      try {
        await apiDeleteNote(id);
        setNotes((prev) => prev.filter((item) => item.id !== id));
      } catch (err) {
        fail(err);
      }
    },
    [fail],
  );

  const saveNoteBody = useCallback(async (id: string, content: string) => {
    await apiSaveNote(id, content);
    // Bump updatedAt locally so ordering stays fresh without a full reload.
    setNotes((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, updatedAt: Math.floor(Date.now() / 1000) } : item,
      ),
    );
  }, []);

  const createPlan = useCallback(
    async (input: PlanInput) => {
      try {
        const plan = await apiCreatePlan(input);
        setPlans((prev) => [plan, ...prev]);
        return plan;
      } catch (err) {
        fail(err);
        return null;
      }
    },
    [fail],
  );

  const savePlan = useCallback(
    async (plan: TravelPlan) => {
      try {
        const next = await apiSavePlan(plan);
        setPlans((prev) => prev.map((item) => (item.id === next.id ? next : item)));
        return next;
      } catch (err) {
        fail(err);
        return null;
      }
    },
    [fail],
  );

  const deletePlan = useCallback(
    async (id: string) => {
      try {
        await apiDeletePlan(id);
        setPlans((prev) => prev.filter((item) => item.id !== id));
      } catch (err) {
        fail(err);
      }
    },
    [fail],
  );

  const setBasemap = useCallback(
    async (basemap: string) => {
      if (!settings) return;
      const next = { ...settings, basemap };
      setSettingsState(next); // optimistic — the map should switch immediately
      try {
        setSettingsState(await setSettings(next));
      } catch (err) {
        fail(err);
      }
    },
    [settings, fail],
  );

  const dismissError = useCallback(() => setError(null), []);

  return {
    loading,
    error,
    notes,
    plans,
    maps,
    settings,
    categories: settings?.categories ?? [],
    reload,
    refreshMaps,
    findNote,
    createNote,
    updateNote,
    deleteNote,
    saveNoteBody,
    createPlan,
    savePlan,
    deletePlan,
    setBasemap,
    dismissError,
  };
}
