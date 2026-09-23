import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createHistoryVersion,
  deleteHistoryEvent,
  deleteHistoryLayer,
  deleteHistoryPerson,
  deleteHistoryPersonRelation,
  importHistoryMap,
  isHistoryTauriRuntime,
  loadHistory,
  previewHistory,
  saveHistoryEvent,
  saveHistoryPerson,
  saveHistoryPersonRelation,
  setHistorySettings,
  updateHistoryFeature,
  updateHistoryLayer,
  type HistoryDocument,
  type HistoryFeature,
  type HistoryEvent,
  type HistoryLayer,
  type HistoryPerson,
  type HistoryPersonRelation,
  type HistoryImportInput,
  type SaveHistoryEventInput,
  type SaveHistoryPersonInput,
  type SaveHistoryPersonRelationInput,
  type UpdateHistoryFeatureInput,
} from "./api";

export interface HistoryData {
  document: HistoryDocument | null;
  loading: boolean;
  error: string | null;
  currentYear: number;
  selectedFeatureId: string | null;
  selectedFeature: HistoryFeature | null;
  setSelectedFeatureId: (id: string | null) => void;
  setCurrentYear: (year: number) => void;
  setBasemap: (basemap: string) => Promise<void>;
  importMap: (input: HistoryImportInput) => Promise<void>;
  saveEvent: (input: SaveHistoryEventInput) => Promise<HistoryEvent | null>;
  deleteEvent: (id: string) => Promise<void>;
  savePerson: (input: SaveHistoryPersonInput) => Promise<HistoryPerson | null>;
  deletePerson: (id: string) => Promise<void>;
  saveRelation: (input: SaveHistoryPersonRelationInput) => Promise<HistoryPersonRelation | null>;
  deleteRelation: (id: string) => Promise<void>;
  updateLayer: (layer: HistoryLayer) => Promise<void>;
  updateFeature: (input: UpdateHistoryFeatureInput) => Promise<void>;
  createVersion: (featureId: string, effectiveYear: number) => Promise<void>;
  deleteLayer: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useHistory(enabled: boolean): HistoryData {
  const browserPreview = !isHistoryTauriRuntime();
  const [document, setDocument] = useState<HistoryDocument | null>(() =>
    browserPreview ? previewHistory() : null,
  );
  const [loading, setLoading] = useState(!browserPreview);
  const [error, setError] = useState<string | null>(null);
  const [currentYear, setCurrentYearState] = useState(200);
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);

  const accept = useCallback((next: HistoryDocument) => {
    setDocument(next);
    setCurrentYearState(next.settings.currentYear);
    setSelectedFeatureId((selected) =>
      selected && next.features.some((feature) => feature.id === selected) ? selected : null,
    );
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      accept(await loadHistory());
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, [accept]);

  useEffect(() => {
    if (!enabled || document) return;
    let cancelled = false;
    void loadHistory()
      .then((next) => {
        if (!cancelled) accept(next);
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accept, document, enabled]);

  useEffect(
    () => () => {
      window.clearTimeout(saveTimer.current);
    },
    [],
  );

  const setCurrentYear = useCallback(
    (year: number) => {
      const nextYear = Math.max(-10_000, Math.min(10_000, Math.round(year)));
      setCurrentYearState(nextYear);
      if (!document) return;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        void setHistorySettings({ ...document.settings, currentYear: nextYear })
          .then(accept)
          .catch((cause) => setError(String(cause)));
      }, 250);
    },
    [accept, document],
  );

  const run = useCallback(
    async (operation: () => Promise<HistoryDocument>) => {
      setError(null);
      try {
        accept(await operation());
      } catch (cause) {
        setError(String(cause));
        throw cause;
      }
    },
    [accept],
  );

  const selectedFeature = useMemo(
    () => document?.features.find((feature) => feature.id === selectedFeatureId) ?? null,
    [document, selectedFeatureId],
  );

  return {
    document,
    loading,
    error,
    currentYear,
    selectedFeatureId,
    selectedFeature,
    setSelectedFeatureId,
    setCurrentYear,
    setBasemap: async (basemap) => {
      if (!document) return;
      await run(() => setHistorySettings({ currentYear, basemap }));
    },
    importMap: async (input) => run(() => importHistoryMap(input)),
    saveEvent: async (input) => {
      let saved: HistoryEvent | null = null;
      await run(async () => {
        const next = await saveHistoryEvent(input);
        if (input.id) {
          saved = next.events.find((event) => event.id === input.id) ?? null;
        } else {
          const matches = next.events.filter((event) => event.title === input.title.trim());
          saved = matches[matches.length - 1] ?? null;
        }
        return next;
      });
      return saved;
    },
    deleteEvent: async (id) => run(() => deleteHistoryEvent(id)),
    savePerson: async (input) => {
      let saved: HistoryPerson | null = null;
      await run(async () => {
        const next = await saveHistoryPerson(input);
        if (input.id) {
          saved = next.people.find((person) => person.id === input.id) ?? null;
        } else {
          const matches = next.people.filter((person) => person.name === input.name.trim());
          saved = matches[matches.length - 1] ?? null;
        }
        return next;
      });
      return saved;
    },
    deletePerson: async (id) => run(() => deleteHistoryPerson(id)),
    saveRelation: async (input) => {
      let saved: HistoryPersonRelation | null = null;
      await run(async () => {
        const next = await saveHistoryPersonRelation(input);
        if (input.id) {
          saved = next.relations.find((relation) => relation.id === input.id) ?? null;
        } else {
          saved = next.relations[next.relations.length - 1] ?? null;
        }
        return next;
      });
      return saved;
    },
    deleteRelation: async (id) => run(() => deleteHistoryPersonRelation(id)),
    updateLayer: async (layer) => run(() => updateHistoryLayer(layer)),
    updateFeature: async (input) => run(() => updateHistoryFeature(input)),
    createVersion: async (featureId, effectiveYear) =>
      run(() => createHistoryVersion(featureId, effectiveYear)),
    deleteLayer: async (id) => run(() => deleteHistoryLayer(id)),
    refresh,
  };
}
