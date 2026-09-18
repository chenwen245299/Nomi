import { useCallback, useEffect, useRef, useState } from "react";
import {
  createProvider,
  deleteProvider,
  fetchProviderModels,
  listProviders,
  providerBalance,
  setDefaultModel,
  setProviderAccessToken,
  setProviderEnabled,
  setProviderKey,
  testProvider,
  updateProvider,
  type FetchedProviderModel,
  type Provider,
  type ProviderBalance,
  type ProviderModel,
} from "./api";

/** Optional spec for a new provider (name-first creation infers the rest). */
export interface NewProviderSpec {
  name?: string;
  kind?: string;
  baseUrl?: string;
  models?: ProviderModel[];
}

export interface ProvidersController {
  providers: Provider[];
  selectedId: string | null;
  selected: Provider | null;
  loading: boolean;
  error: string | null;
  select: (id: string) => void;
  add: (spec?: NewProviderSpec) => Promise<void>;
  save: (provider: Provider) => Promise<void>;
  toggleEnabled: (id: string, enabled: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
  saveKey: (id: string, key: string) => Promise<void>;
  saveAccessToken: (id: string, token: string) => Promise<void>;
  test: (id: string) => Promise<{ ok: boolean; message: string }>;
  fetchModels: (id: string) => Promise<FetchedProviderModel[]>;
  balance: (id: string) => Promise<ProviderBalance>;
  setDefaultModel: (providerId: string, modelId: string) => Promise<void>;
}

export function useProviders(active: boolean): ProvidersController {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const refresh = useCallback(async (preferId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const list = await listProviders();
      setProviders(list);
      setSelectedId((current) => {
        const wanted = preferId ?? current;
        if (wanted && list.some((item) => item.id === wanted)) {
          return wanted;
        }
        return list[0]?.id ?? null;
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active || loadedRef.current) {
      return;
    }
    loadedRef.current = true;
    void refresh();
  }, [active, refresh]);

  const select = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  const add = useCallback(
    async (spec?: NewProviderSpec) => {
      let createdId: string | undefined;
      try {
        const created = await createProvider(
          spec?.name?.trim() || "新服务商",
          spec?.kind ?? "openai",
          spec?.baseUrl ?? "",
        );
        createdId = created.id;
        // Preset models (if any) need a follow-up save — create only takes metadata.
        if (spec?.models?.length) {
          await updateProvider({ ...created, models: spec.models });
        }
      } catch (err) {
        setError(String(err));
      } finally {
        // Always re-list: even if the models update failed, the provider was
        // created on disk, so surface (and select) it rather than hiding it.
        await refresh(createdId);
      }
    },
    [refresh],
  );

  const save = useCallback(async (provider: Provider) => {
    try {
      const saved = await updateProvider(provider);
      setProviders((prev) => prev.map((item) => (item.id === saved.id ? saved : item)));
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const toggleEnabled = useCallback(async (id: string, enabled: boolean) => {
    setProviders((prev) => prev.map((item) => (item.id === id ? { ...item, enabled } : item)));
    try {
      await setProviderEnabled(id, enabled);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const remove = useCallback(
    async (id: string) => {
      try {
        await deleteProvider(id);
        await refresh();
      } catch (err) {
        setError(String(err));
      }
    },
    [refresh],
  );

  const saveKey = useCallback(async (id: string, key: string) => {
    try {
      await setProviderKey(id, key);
      setProviders((prev) =>
        prev.map((item) => (item.id === id ? { ...item, hasKey: key.trim().length > 0 } : item)),
      );
    } catch (err) {
      setError(String(err));
      throw err;
    }
  }, []);

  const saveAccessToken = useCallback(async (id: string, token: string) => {
    try {
      await setProviderAccessToken(id, token);
      setProviders((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, hasAccessToken: token.trim().length > 0 } : item,
        ),
      );
    } catch (err) {
      setError(String(err));
      throw err;
    }
  }, []);

  const test = useCallback(async (id: string) => {
    try {
      const message = await testProvider(id);
      return { ok: true, message };
    } catch (err) {
      return { ok: false, message: String(err) };
    }
  }, []);

  const fetchModels = useCallback(async (id: string) => {
    return fetchProviderModels(id);
  }, []);

  const balance = useCallback(async (id: string) => {
    return providerBalance(id);
  }, []);

  const chooseDefaultModel = useCallback(async (providerId: string, modelId: string) => {
    try {
      const list = await setDefaultModel(providerId, modelId);
      setProviders(list);
    } catch (err) {
      setError(String(err));
      throw err;
    }
  }, []);

  const selected = providers.find((item) => item.id === selectedId) ?? null;

  return {
    providers,
    selectedId,
    selected,
    loading,
    error,
    select,
    add,
    save,
    toggleEnabled,
    remove,
    saveKey,
    saveAccessToken,
    test,
    fetchModels,
    balance,
    setDefaultModel: chooseDefaultModel,
  };
}
