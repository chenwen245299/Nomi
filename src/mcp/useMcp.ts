import { useCallback, useEffect, useRef, useState } from "react";
import {
  getMcpClientConfig,
  getMcpStatus,
  setMcpEnabled,
  type McpClientConfig,
  type McpStatus,
} from "./api";

export interface McpController {
  status: McpStatus | null;
  config: McpClientConfig | null;
  loading: boolean;
  error: string | null;
  toggleEnabled: (enabled: boolean) => Promise<void>;
}

export function useMcp(active: boolean): McpController {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [config, setConfig] = useState<McpClientConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!active || loadedRef.current) {
      return;
    }
    loadedRef.current = true;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const [nextStatus, nextConfig] = await Promise.all([getMcpStatus(), getMcpClientConfig()]);
        if (!cancelled) {
          setStatus(nextStatus);
          setConfig(nextConfig);
        }
      } catch (err) {
        if (!cancelled) {
          setError(String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  const toggleEnabled = useCallback(async (enabled: boolean) => {
    // Optimistic — the toggle should feel instant; revert on failure.
    setStatus((prev) => ({ ...(prev ?? { enabled }), enabled }));
    try {
      const next = await setMcpEnabled(enabled);
      setStatus(next);
    } catch (err) {
      setError(String(err));
      setStatus((prev) => ({ ...(prev ?? { enabled: !enabled }), enabled: !enabled }));
    }
  }, []);

  return { status, config, loading, error, toggleEnabled };
}
