// ── Place search (geocoding) ──────────────────────────────────────────────────
// Keyless OpenStreetMap Nominatim, biased to the map's current viewport so a
// search for "咖啡" or "博物馆" focuses on the area the user is already looking at
// (as requested). Falls back to an unbounded search when the bounded one is empty.

export interface GeoResult {
  /** Short display label (first segment of Nominatim's display_name). */
  name: string;
  /** Full address string. */
  displayName: string;
  lat: number;
  lng: number;
  /** e.g. "restaurant", "city" — used only for a small hint chip. */
  kind: string;
}

/** [west, south, east, north] in WGS-84 degrees. */
export type ViewBox = [number, number, number, number];

const ENDPOINT = "https://nominatim.openstreetmap.org/search";
const REVERSE_ENDPOINT = "https://nominatim.openstreetmap.org/reverse";

interface NominatimItem {
  display_name: string;
  lat: string;
  lon: string;
  name?: string;
  type?: string;
  category?: string;
}

function toResults(items: NominatimItem[]): GeoResult[] {
  return items
    .map((item) => {
      const lat = Number(item.lat);
      const lng = Number(item.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      const name =
        item.name?.trim() || item.display_name.split(",")[0]?.trim() || item.display_name;
      return {
        name,
        displayName: item.display_name,
        lat,
        lng,
        kind: item.type || item.category || "",
      } satisfies GeoResult;
    })
    .filter((item): item is GeoResult => item !== null);
}

async function query(
  q: string,
  viewbox: ViewBox | null,
  bounded: boolean,
  signal?: AbortSignal,
): Promise<GeoResult[]> {
  const params = new URLSearchParams({
    q,
    format: "jsonv2",
    limit: "8",
    "accept-language": "zh-CN,zh",
    addressdetails: "0",
  });
  if (viewbox) {
    params.set("viewbox", viewbox.join(","));
    if (bounded) params.set("bounded", "1");
  }
  const response = await fetch(`${ENDPOINT}?${params.toString()}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`搜索失败：${response.status}`);
  const items = (await response.json()) as NominatimItem[];
  return toResults(items);
}

/**
 * Search for places matching `q`. When `viewbox` is given, results inside it come
 * first; if the viewport-restricted search finds nothing, a wider search runs so
 * the user can still jump somewhere far away by name.
 */
export async function searchPlaces(
  q: string,
  viewbox: ViewBox | null,
  signal?: AbortSignal,
): Promise<GeoResult[]> {
  const trimmed = q.trim();
  if (trimmed.length < 1) return [];
  if (viewbox) {
    const bounded = await query(trimmed, viewbox, true, signal);
    if (bounded.length > 0) return bounded;
  }
  return query(trimmed, viewbox, false, signal);
}

/** Best-effort address for a coordinate (fills the address field on map pick). */
export async function reverseGeocode(
  lat: number,
  lng: number,
  signal?: AbortSignal,
): Promise<string> {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lng),
    format: "jsonv2",
    "accept-language": "zh-CN,zh",
    zoom: "14",
  });
  try {
    const response = await fetch(`${REVERSE_ENDPOINT}?${params.toString()}`, {
      signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return "";
    const item = (await response.json()) as { display_name?: string; name?: string };
    return item.name?.trim() || item.display_name?.trim() || "";
  } catch {
    return "";
  }
}
