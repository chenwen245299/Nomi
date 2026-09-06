// ── "Light-up" administrative boundaries ──────────────────────────────────────
// Resolves travel-note coordinates to the administrative region that contains
// them, at a chosen level (country / province / city / county), so the trajectory
// view can highlight everywhere you've been. China regions come from Alibaba
// DataV (keyless, WGS-84, CORS-open, reliable in China); other countries come
// from a small bundled world-countries file. Point-in-polygon is done locally.

export type RegionLevel = "country" | "province" | "city" | "county";

export const LEVEL_LABELS: Record<RegionLevel, string> = {
  country: "国家",
  province: "省/州",
  city: "市",
  county: "县/区",
};

type Ring = number[][];
type Poly = Ring[];
type Geometry =
  | { type: "Polygon"; coordinates: Poly }
  | { type: "MultiPolygon"; coordinates: Poly[] }
  | { type: string; coordinates: unknown };

export interface RegionFeature {
  type: "Feature";
  properties: { name?: string; adcode?: number | string; [k: string]: unknown };
  geometry: Geometry;
}

export interface RegionCollection {
  type: "FeatureCollection";
  features: RegionFeature[];
}

const DATAV = "https://geo.datav.aliyun.com/areas_v3/bound";
const CHINA_ADCODE = "100000";

// The compact Natural Earth-derived world file intentionally omits some small
// sovereign states. Its simplified Malaysia polygon also reaches across
// Singapore, so a Singapore point would otherwise be attributed to Malaysia.
// Keep a small, local mainland outline and resolve these overrides before the
// coarse world polygons. This is deliberately bundled so trajectory matching
// remains reliable offline.
const COUNTRY_OVERRIDES: RegionFeature[] = [
  {
    type: "Feature",
    properties: { name: "Singapore", code: "SGP" },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [103.598, 1.395],
          [103.638, 1.452],
          [103.72, 1.469],
          [103.807, 1.478],
          [103.875, 1.452],
          [103.969, 1.42],
          [104.015, 1.366],
          [104.047, 1.324],
          [104.0, 1.278],
          [103.918, 1.248],
          [103.85, 1.235],
          [103.78, 1.245],
          [103.7, 1.257],
          [103.641, 1.284],
          [103.603, 1.337],
          [103.598, 1.395],
        ],
      ],
    },
  },
];

// ── Point-in-polygon (ray casting, holes-aware, MultiPolygon-aware) ───────────
function pointInRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPoly(x: number, y: number, poly: Poly): boolean {
  if (poly.length === 0 || !pointInRing(x, y, poly[0])) return false;
  for (let h = 1; h < poly.length; h += 1) {
    if (pointInRing(x, y, poly[h])) return false; // inside a hole
  }
  return true;
}

export function pointInGeometry(lng: number, lat: number, geometry: Geometry): boolean {
  if (geometry.type === "Polygon") return pointInPoly(lng, lat, geometry.coordinates as Poly);
  if (geometry.type === "MultiPolygon") {
    return (geometry.coordinates as Poly[]).some((poly) => pointInPoly(lng, lat, poly));
  }
  return false;
}

// ── Data loading (cached) ─────────────────────────────────────────────────────
const cache = new Map<string, RegionCollection>();
let worldPromise: Promise<RegionCollection> | null = null;

async function fetchBound(key: string, signal?: AbortSignal): Promise<RegionCollection> {
  const cached = cache.get(key);
  if (cached) return cached;
  const response = await fetch(`${DATAV}/${key}.json`, { signal });
  if (!response.ok) throw new Error(`加载行政边界失败：${response.status}`);
  const collection = (await response.json()) as RegionCollection;
  cache.set(key, collection);
  return collection;
}

/** All Chinese provinces (with `adcode` for the city/county cascade). */
const loadProvinces = (signal?: AbortSignal) => fetchBound(`${CHINA_ADCODE}_full`, signal);
/** Children of an adcode: cities of a province, or districts/counties of a city. */
const loadChildren = (adcode: number | string, signal?: AbortSignal) =>
  fetchBound(`${adcode}_full`, signal);
/** China's national outline (single feature), used at the country level. */
const loadChinaOutline = (signal?: AbortSignal) => fetchBound(CHINA_ADCODE, signal);

async function loadWorld(): Promise<RegionCollection> {
  if (!worldPromise) {
    worldPromise = import("./data/world-countries.json").then(
      (module) => module.default as unknown as RegionCollection,
    );
  }
  return worldPromise;
}

const featureKey = (feature: RegionFeature) =>
  String(feature.properties.adcode ?? feature.properties.name ?? Math.random());

export interface Point {
  lat: number;
  lng: number;
}

/**
 * The set of regions (deduped) that contain at least one of `points`, at the
 * given level. Returns a FeatureCollection ready to drop onto the map. Throws if
 * the boundary data can't be loaded (the caller shows a hint).
 */
export async function litRegions(
  points: Point[],
  level: RegionLevel,
  signal?: AbortSignal,
): Promise<RegionCollection> {
  const lit = new Map<string, RegionFeature>();
  if (points.length === 0) return { type: "FeatureCollection", features: [] };

  if (level === "country") {
    const [chinaFc, world] = await Promise.all([loadChinaOutline(signal), loadWorld()]);
    const china = chinaFc.features[0];
    let anyChina = false;
    for (const point of points) {
      const override = COUNTRY_OVERRIDES.find((feature) =>
        pointInGeometry(point.lng, point.lat, feature.geometry),
      );
      if (override) {
        lit.set(`override:${override.properties.name}`, override);
        continue;
      }
      if (china && pointInGeometry(point.lng, point.lat, china.geometry)) {
        anyChina = true;
        continue;
      }
      const country = world.features.find((feature) =>
        pointInGeometry(point.lng, point.lat, feature.geometry),
      );
      if (country) lit.set(`w:${country.properties.name}`, country);
    }
    if (anyChina && china) lit.set("cn", china);
    return { type: "FeatureCollection", features: [...lit.values()] };
  }

  // province / city / county → cascade through China's DataV boundaries.
  const provinces = await loadProvinces(signal);
  for (const point of points) {
    const province = provinces.features.find((feature) =>
      pointInGeometry(point.lng, point.lat, feature.geometry),
    );
    if (!province) continue; // outside China — skip at these levels
    if (level === "province") {
      lit.set(featureKey(province), province);
      continue;
    }
    const cities = await loadChildren(province.properties.adcode ?? "", signal);
    const city = cities.features.find((feature) =>
      pointInGeometry(point.lng, point.lat, feature.geometry),
    );
    if (!city) continue;
    if (level === "city") {
      lit.set(featureKey(city), city);
      continue;
    }
    const counties = await loadChildren(city.properties.adcode ?? "", signal);
    const county = counties.features.find((feature) =>
      pointInGeometry(point.lng, point.lat, feature.geometry),
    );
    if (county) lit.set(featureKey(county), county);
  }
  return { type: "FeatureCollection", features: [...lit.values()] };
}
